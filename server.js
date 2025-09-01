// server.js
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}?width=${width}`;
}

function parseTime(wbTime) {
  if (!wbTime?.time) return null;
  const iso = wbTime.time.replace(/^\+/, "");
  return iso.substring(0, 10);
}

function formatFallbackSummary({ label, description, birthDate, deathDate, occupations }) {
  const life = birthDate || deathDate ? ` (${birthDate || "…"} – ${deathDate || ""})` : "";
  const occ = occupations?.length ? ` ${occupations.join(", ")}.` : "";
  return [
    `<p><strong>${label}</strong>${life}${description ? ` — ${description}.` : ""}</p>`,
    occ ? `<p><strong>Occupation:</strong> ${occupations.join(", ")}</p>` : "",
  ].join("");
}

async function resolveLabels(ids, lang) {
  if (!ids?.length) return {};
  const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*&ids=${ids.join("|")}&languages=${lang}|en`;
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
  const sUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=${lang}&origin=*&search=${encodeURIComponent(term)}`;
  const sData = await getJSON(sUrl);
  if (!sData.search?.length) throw new Error("No results in Wikidata");
  const top = sData.search[0];
  const qid = top.id;

  const eUrl = `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`;
  const eData = await getJSON(eUrl);
  const entity = eData.entities[qid];

  const label = entity.labels?.[lang]?.value || entity.labels?.en?.value || top.label || qid;
  const description = entity.descriptions?.[lang]?.value || entity.descriptions?.en?.value || top.description || "";

  const claims = entity.claims || {};
  const P569 = claims.P569?.[0]?.mainsnak?.datavalue?.value; // birth
  const P570 = claims.P570?.[0]?.mainsnak?.datavalue?.value; // death
  const P106 = (claims.P106 || []).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean); // occupation ids
  const P18 = claims.P18?.[0]?.mainsnak?.datavalue?.value; // image filename

  const birthDate = parseTime(P569);
  const deathDate = parseTime(P570);
  const occLabelMap = await resolveLabels(P106, lang);
  const occupations = P106.map((id) => occLabelMap[id]).filter(Boolean);

  const siteKey = `${lang}wiki`;
  const enKey = "enwiki";
  const siteTitle = entity.sitelinks?.[siteKey]?.title || entity.sitelinks?.[enKey]?.title || null;

  const wikipediaUrl = siteTitle ? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(siteTitle)}` : null;

  let wikiExtract = "";
  let thumb = P18 ? commonsImageUrl(P18, 800) : null;

  if (siteTitle) {
    try {
      const sumUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(siteTitle)}`;
      const sum = await getJSON(sumUrl);
      if (sum?.extract) wikiExtract = sum.extract;
      if (!thumb && sum?.thumbnail?.source) thumb = sum.thumbnail.source;
    } catch (e) {
      // ignore
    }
  }

  const summaryHTML = wikiExtract
    ? wikiExtract.split("\n\n").map((p) => `<p>${p}</p>`).join("")
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
    siteTitle,
  };
}

// ---- Routes ----
app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    const lang = (req.query.lang || "en").toString();
    if (!q) return res.status(400).json({ error: "Missing q" });

    const data = await fetchEntityBySearch(q, lang);
    return res.json({ ok: true, result: data });
  } catch (e) {
    console.error("Search error:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/article/:lang/:title", async (req, res) => {
  try {
    const { lang, title } = req.params;
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*&prop=extracts&explaintext=true&exintro=false&redirects=1&titles=${encodeURIComponent(
      title
    )}`;
    const data = await getJSON(url);
    const pages = data?.query?.pages || {};
    const pageId = Object.keys(pages)[0];
    if (!pageId || pageId === "-1") throw new Error("No page text");
    const extract = pages[pageId].extract || "";

    return res.json({
      ok: true,
      title: pages[pageId].title,
      contentHtml: extract.split("\n\n").map((p) => `<p>${p.trim()}</p>`).join(""),
    });
  } catch (e) {
    console.error("Article error:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/summarize", async (req, res) => {
  try {
    const { text, language = "en" } = req.body || {};
    if (!text || text.length < 40) {
      return res.status(400).json({ ok: false, error: "Insufficient text to summarize" });
    }

    const key = process.env.GROQ_API_KEY;
    const model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

    if (!key) {
      console.warn("No GROQ_API_KEY found, running in offline mode.");
      const first = text.split("\n").filter(Boolean).slice(0, 3).join(" ");
      return res.json({
        ok: true,
        summary: `Summary (offline): ${first.slice(0, 600)}${first.length > 600 ? "…" : ""}`,
      });
    }

    // Groq API request (OpenAI-compatible)
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.5,
        messages: [
          { role: "system", content: "You are a summarizer that produces clear, concise 3–5 paragraph summaries." },
          { role: "user", content: `Language: ${language}\n\nSummarize:\n\n${text}` },
        ],
      }),
    });

    const j = await r.json();
    if (!r.ok || j.error) {
      console.error("Groq API error:", j.error || j);
      throw new Error(j.error?.message || "Groq request failed");
    }

    const summary = j?.choices?.[0]?.message?.content?.trim();
    if (!summary) throw new Error("Groq summary failed");

    return res.json({ ok: true, summary });
  } catch (e) {
    console.error("Summarize error:", e);
    return res.status(500).json({ ok: false, error: e.message || "Internal error" });
  }
});


// ---- Start server ----
app.listen(PORT, () => {
  console.log(` API ready on http://localhost:${PORT}`);
});

// ---- Start server (local only) ----
// if (process.env.NODE_ENV !== "production") {
//   app.listen(PORT, () => {
//     console.log(`Server running locally at http://localhost:${PORT}`);
//   });
// }

// Export for Vercel (ES module style)
// export default app;

// ---- Optional: graceful error logging ----
process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

// module.exports = app;  // Required for Vercel
//export default app;