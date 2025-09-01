import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";   // ⬅️ add this
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ---- Helpers ----
async function getJSON(url) {
  const res = await fetch(url, { headers: { "User-Agent": "WikidataSmartSummary/1.0" } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
  return res.json();
}

function commonsImageUrl(filename, width = 600) {
  if (!filename) return null;
  // Best-effort: Special:FilePath serves original; for thumbs you can use IIIF or thumb.php
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}?width=${width}`;
}

function parseTime(wbTime) {
  // wbTime: { time: '+1879-03-14T00:00:00Z', precision: 11, ... }
  if (!wbTime?.time) return null;
  const iso = wbTime.time.replace(/^\+/, '');
  return iso.substring(0, 10);
}

function formatFallbackSummary({ label, description, birthDate, deathDate, occupations }) {
  const life = birthDate || deathDate ? ` (${birthDate || '…'} – ${deathDate || ''})` : '';
  const occ = occupations?.length ? ` ${occupations.join(', ')}.` : '';
  return [
    `<p><strong>${label}</strong>${life}${description ? ` — ${description}.` : ''}</p>`,
    occ ? `<p><strong>Occupation:</strong> ${occupations.join(', ')}</p>` : ''
  ].join('');
}

async function resolveLabels(ids, lang) {
  if (!ids?.length) return {};
  const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*&ids=${ids.join('|')}&languages=${lang}|en`;
  const data = await getJSON(url);
  const out = {};
  for (const id of ids) {
    const ent = data.entities[id];
    out[id] = ent?.labels?.[lang]?.value || ent?.labels?.en?.value || id;
  }
  return out;
}

// ---- Core: Wikidata + Wikipedia combo ----
async function fetchEntityBySearch(term, lang) {
  // 1) Search for entity ID
  const sUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=${lang}&origin=*&search=${encodeURIComponent(term)}`;
  const sData = await getJSON(sUrl);
  if (!sData.search?.length) throw new Error('No results in Wikidata');
  const top = sData.search[0];
  const qid = top.id;

  // 2) Fetch full entity
  const eUrl = `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`;
  const eData = await getJSON(eUrl);
  const entity = eData.entities[qid];

  const label = entity.labels?.[lang]?.value || entity.labels?.en?.value || top.label || qid;
  const description = entity.descriptions?.[lang]?.value || entity.descriptions?.en?.value || top.description || '';

  const claims = entity.claims || {};
  const P569 = claims.P569?.[0]?.mainsnak?.datavalue?.value; // birth
  const P570 = claims.P570?.[0]?.mainsnak?.datavalue?.value; // death
  const P106 = (claims.P106 || []).map(c => c.mainsnak?.datavalue?.value?.id).filter(Boolean); // occupation ids
  const P18  = claims.P18?.[0]?.mainsnak?.datavalue?.value; // image filename

  const birthDate = parseTime(P569);
  const deathDate = parseTime(P570);
  const occLabelMap = await resolveLabels(P106, lang);
  const occupations = P106.map(id => occLabelMap[id]).filter(Boolean);

  // sitelinks for Wikipedia page in lang (fallback en)
  const siteKey = `${lang}wiki`;
  const enKey = 'enwiki';
  const siteTitle =
    entity.sitelinks?.[siteKey]?.title ||
    entity.sitelinks?.[enKey]?.title || null;

  const wikipediaUrl = siteTitle
    ? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(siteTitle)}`
    : null;

  // Try to fetch a clean summary & thumbnail from Wikipedia REST if sitelink found
  let wikiExtract = '';
  let thumb = P18 ? commonsImageUrl(P18, 800) : null;

  if (siteTitle) {
    try {
      const sumUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(siteTitle)}`;
      const sum = await getJSON(sumUrl);
      if (sum?.extract) wikiExtract = sum.extract;
      if (!thumb && sum?.thumbnail?.source) thumb = sum.thumbnail.source;
    } catch {}
  }

  const summaryHTML =
    wikiExtract
      ? wikiExtract.split('\n\n').map(p => `<p>${p}</p>`).join('')
      : formatFallbackSummary({ label, description, birthDate, deathDate, occupations });

  return {
    qid,
    label,
    description,
    image: thumb || null,
    birthDate,
    deathDate,
    occupations,
    wikipediaUrl,
    language: lang,
    contentHtml: summaryHTML,
    siteTitle
  };
}

// ---- Routes ----

// GET /api/search?q=term&lang=en
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const lang = (req.query.lang || 'en').toString();
    if (!q) return res.status(400).json({ error: 'Missing q' });

    const data = await fetchEntityBySearch(q, lang);
    return res.json({ ok: true, result: data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/article/:lang/:title  (full plain-text extract)
app.get('/api/article/:lang/:title', async (req, res) => {
  try {
    const { lang, title } = req.params;
    const url =
      `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*&prop=extracts&explaintext=true&exintro=false&redirects=1&titles=${encodeURIComponent(title)}`;
    const data = await getJSON(url);
    const pages = data?.query?.pages || {};
    const pageId = Object.keys(pages)[0];
    if (!pageId || pageId === '-1') throw new Error('No page text');
    const extract = pages[pageId].extract || '';

    // Return as simple paragraphs
    return res.json({
      ok: true,
      title: pages[pageId].title,
      contentHtml: extract
        .split('\n\n')
        .map(p => `<p>${p.trim()}</p>`)
        .join('')
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/summarize  { text: "...", language: "en" }
app.post("/api/summarize", async (req, res) => {
  try {
    const { text, language = "en" } = req.body || {};
    if (!text || text.length < 40) {
      return res.status(400).json({ ok: false, error: "Insufficient text to summarize" });
    }

    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      const first = text.split("\n").filter(Boolean).slice(0, 3).join(" ");
      return res.json({
        ok: true,
        summary: `Summary (offline): ${first.slice(0, 600)}${first.length > 600 ? "…" : ""}`,
      });
    }

    // OpenAI request
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.5,
        messages: [
          { role: "system", content: "You produce concise, well-structured summaries with short paragraphs." },
          { role: "user", content: `Language: ${language}\n\nSummarize clearly, 3–5 short paragraphs with key facts:\n\n${text}` },
        ],
      }),
    });

    const j = await r.json();

    // ✅ Better error handling
    if (j.error) {
      console.error("❌ OpenAI API Error:", j.error);
      throw new Error(j.error.message || "OpenAI request failed");
    }

    const summary = j?.choices?.[0]?.message?.content?.trim();
    if (!summary) throw new Error("AI summary failed");

    return res.json({ ok: true, summary });
  } catch (e) {
    console.error("❌ Summarize error:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 API ready on http://localhost:${PORT}`);
});
