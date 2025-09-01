document.addEventListener('DOMContentLoaded', () => {

  // Load required libraries for PDF generation
  const script = document.createElement('script');
  script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  document.head.appendChild(script);
  
  const script2 = document.createElement('script');
  script2.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  document.head.appendChild(script2);
  // ---- Elements
  const languageSelect = document.getElementById('language-select');
  const searchInput    = document.getElementById('searchInput');
  const searchButton   = document.getElementById('searchButton');
  const loading        = document.getElementById('loadingIndicator');
  const errorAlert     = document.getElementById('errorAlert');
  const results        = document.getElementById('resultsContainer');
  const titleEl        = document.getElementById('resultTitle');
  const contentEl      = document.getElementById('resultContent');
  const imgContainer   = document.getElementById('imageContainer');
  const wikiLink       = document.getElementById('fullArticleLink');
  const factBox        = document.getElementById('factBox');
  const factList       = document.getElementById('factList');
  const readMoreBtn    = document.getElementById('readMoreBtn');

  const readBtn        = document.getElementById('readAloudBtn');
  const stopBtn        = document.getElementById('stopReadingBtn');

  const notesSection   = document.getElementById('notesSection');
  const noteField      = document.getElementById('articleNote');
  const saveNoteBtn    = document.getElementById('saveNoteBtn');
  const noteSavedAlert = document.getElementById('noteSavedAlert');

  const historyList    = document.getElementById('searchHistory');
  const clearHistoryBtn= document.getElementById('clearHistoryBtn');
  const darkToggle     = document.getElementById('darkModeToggle');
  const downloadPdfBtn = document.getElementById('downloadPdfBtn');
  const shareCardBtn = document.getElementById('shareCardBtn');

  // ---- State
  let searchHistory = JSON.parse(localStorage.getItem('wds_history') || '[]');
  let current = null; // last search result
  let speech = window.speechSynthesis;
  let currentUtterance = null;

  // ---- Dark mode
  const storedDark = localStorage.getItem('dark') === 'true';
  if (storedDark) {
    document.body.classList.add('dark-mode');
    darkToggle.checked = true;
  }
  darkToggle.addEventListener('change', (e) => {
    document.body.classList.toggle('dark-mode', e.target.checked);
    localStorage.setItem('dark', e.target.checked);
  });

  // ---- Language
  const savedLang = localStorage.getItem('lang') || 'en';
  languageSelect.value = savedLang;
  languageSelect.addEventListener('change', () => {
    localStorage.setItem('lang', languageSelect.value);
  });

  // ---- Helpers
  function setLoading(v) { loading.classList.toggle('d-none', !v); }
  function setError(msg) {
    if (!msg) { errorAlert.classList.add('d-none'); errorAlert.textContent = ''; return; }
    errorAlert.textContent = msg;
    errorAlert.classList.remove('d-none');
  }
  function show(el) { el.classList.remove('d-none'); }
  function hide(el) { el.classList.add('d-none'); }

  // function formatFacts(r) {
  //   const rows = [];
  //   if (r.birthDate) rows.push(`<li><strong>Born:</strong> ${r.birthDate}</li>`);
  //   if (r.deathDate) rows.push(`<li><strong>Died:</strong> ${r.deathDate}</li>`);
  //   if (r.occupations?.length) rows.push(`<li><strong>Occupation:</strong> ${r.occupations.join(', ')}</li>`);
  //   rows.push(`<li><strong>Wikidata:</strong> <a href="https://www.wikidata.org/wiki/${r.qid}" target="_blank">${r.qid}</a></li>`);
  //   factList.innerHTML = rows.join('');
  //   if (rows.length) show(factBox); else hide(factBox);
  // }

  function formatFacts(r) {
  const rows = [];

  if (r.birthDate)
    rows.push(`<li><strong>Born:</strong> ${r.birthDate}</li>`);

  if (r.deathDate)
    rows.push(`<li><strong>Died:</strong> ${r.deathDate}</li>`);

  if (r.occupations?.length)
    rows.push(`<li><strong>Occupation:</strong> ${r.occupations.join(', ')}</li>`);

  // Always show Wikidata link
  rows.push(
    `<li><strong>Wikidata:</strong> 
      <a href="https://www.wikidata.org/wiki/${r.qid}" target="_blank">${r.qid}</a>
    </li>`
  );

  // If no image available → link to Wikimedia Commons search
  if (!r.image && r.label) {
    const searchQuery = encodeURIComponent(r.label);
    rows.push(
      `<li><strong>Image:</strong> 
        <a href="https://commons.wikimedia.org/wiki/Special:MediaSearch?type=image&search=${searchQuery}" target="_blank">
          Search / Upload on Wikimedia Commons
        </a>
      </li>`
    );
  }

  factList.innerHTML = rows.join('');
  if (rows.length) show(factBox);
  else hide(factBox);
}


  function displayImage(src, alt) {
    if (src) {
      imgContainer.innerHTML = `<img class="w-100" src="${src}" alt="${alt}" />`;
    } else {
      imgContainer.innerHTML = `<div class="text-muted small py-5">No image</div>`;
    }
  }

  function displayResult(r) {
    current = r;
    titleEl.textContent = r.label;
    // contentEl.innerHTML = r.contentHtml || '<p>No summary available.</p>';
    contentEl.innerHTML = formatArticleText(r.contentHtml || r.content || '');

    displayImage(r.image, r.label);
    wikiLink.href = r.wikipediaUrl || `https://www.wikidata.org/wiki/${r.qid}`;
    formatFacts(r);

    // Notes
    const saved = localStorage.getItem(`note_${r.qid}`) || '';
    noteField.value = saved;
    show(notesSection);

    // Read more (only if we have a Wikipedia sitelink title)
    if (r.siteTitle && r.language) {
      show(readMoreBtn);
      readMoreBtn.onclick = () => expandFullArticle(r.language, r.siteTitle);
    } else {
      hide(readMoreBtn);
    }

    // History
    upsertHistory(r.label);

    show(results);
  }

  function formatArticleText(text) {
  if (!text) return "<p>No content available.</p>";

  // Remove extra spaces and normalize
  let clean = text.replace(/\s+/g, " ").trim();

  // Split by double newlines OR sentence breaks
  let paragraphs = clean
    .split(/\n{2,}|\.(?=\s+[A-Z])/g) // split on blank lines or ". " followed by uppercase
    .map(p => p.trim())
    .filter(p => p.length > 0);

  // Wrap each in <p>
  return paragraphs.map(p => `<p>${p}${p.endsWith('.') ? '' : '.'}</p>`).join("\n");
}


  // async function expandFullArticle(lang, title) {
  //   try {
  //     readMoreBtn.disabled = true;
  //     readMoreBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Loading…';
  //     const res = await fetch(`/api/article/${lang}/${encodeURIComponent(title)}`);
  //     const j = await res.json();
  //     if (j.ok) {
  //       contentEl.innerHTML = j.contentHtml;
  //     } else throw new Error(j.error || 'Failed to load full article');
  //   } catch (e) {
  //     setError(e.message);
  //   } finally {
  //     readMoreBtn.disabled = false;
  //     readMoreBtn.innerHTML = '<i class="bi bi-arrows-angle-expand"></i> Read more';
  //   }
  // }

  async function expandFullArticle(lang, title) {
  try {
    readMoreBtn.disabled = true;
    readMoreBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Loading…';

    const res = await fetch(`/api/article/${lang}/${encodeURIComponent(title)}`);
    const j = await res.json();

    if (j.ok) {
      // Use the formatter for consistent display
      contentEl.innerHTML = formatArticleText(j.contentHtml || j.content || '');
    } else {
      throw new Error(j.error || 'Failed to load full article');
    }

  } catch (e) {
    setError(e.message);
  } finally {
    readMoreBtn.disabled = false;
    readMoreBtn.innerHTML = '<i class="bi bi-arrows-angle-expand"></i> Read more';
  }
}



  function upsertHistory(term) {
    if (!term) return;
    searchHistory = [term, ...searchHistory.filter(t => t !== term)].slice(0, 8);
    localStorage.setItem('wds_history', JSON.stringify(searchHistory));
    renderHistory();
  }

  function renderHistory() {
    historyList.innerHTML = '';
    if (!searchHistory.length) return;
    searchHistory.forEach((term) => {
      const li = document.createElement('li');
      li.className = 'list-group-item list-group-item-action';
      li.textContent = term;
      li.onclick = () => { searchInput.value = term; doSearch(term); };
      historyList.appendChild(li);
    });
  }

  // ---- Speech
  function readAloud(text) {
    if (!text?.trim()) return;
    if (speech.speaking) speech.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const lang = languageSelect.value || 'en';
    const voice = speech.getVoices().find(v => v.lang.startsWith(lang));
    if (voice) u.voice = voice;
    u.onend = () => { hide(stopBtn); show(readBtn); };
    speech.speak(u);
    currentUtterance = u;
    hide(readBtn); show(stopBtn);
  }

  function stopReading() {
    if (speech.speaking) speech.cancel();
    hide(stopBtn); show(readBtn);
  }

  readBtn.onclick  = () => readAloud(contentEl.textContent);
  stopBtn.onclick  = stopReading;

  if (typeof speech !== 'undefined' && speech.onvoiceschanged !== undefined) {
    speech.onvoiceschanged = () => {};
  }

  // ---- Notes
  saveNoteBtn.onclick = () => {
    if (!current) return;
    localStorage.setItem(`note_${current.qid}`, noteField.value || '');
    noteSavedAlert.classList.remove('d-none');
    setTimeout(() => noteSavedAlert.classList.add('d-none'), 1500);
  };

  // ---- Search
  async function doSearch(term) {
    const q = (term ?? searchInput.value ?? '').trim();
    if (!q) return;
    setError('');
    setLoading(true);
    hide(results);

    try {
      const lang = languageSelect.value || 'en';
      const resp = await fetch(`/api/search?q=${encodeURIComponent(q)}&lang=${encodeURIComponent(lang)}`);
      const j = await resp.json();
      if (!j.ok) throw new Error(j.error || 'Failed');
      displayResult(j.result);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  searchButton.onclick = () => doSearch();
  searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') doSearch();
  });

  // ---- Clear history
  clearHistoryBtn.onclick = () => {
    if (!searchHistory.length) return;
    if (confirm('Clear all search history?')) {
      searchHistory = [];
      localStorage.removeItem('wds_history');
      renderHistory();
    }
  };

  renderHistory();

  // ---- AI Summary (optional)
  const summarizeBtn = document.getElementById('summarizeBtn');
  summarizeBtn.onclick = async () => {
    try {
      summarizeBtn.disabled = true;
      summarizeBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Summarizing…';
      const text = contentEl.textContent || '';
      const language = languageSelect.value || 'en';
      const r = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language })
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Failed to summarize');
      contentEl.innerHTML = j.summary
        .split(/\n{2,}/g)
        .map(p => `<p>${p.trim()}</p>`)
        .join('');
    } catch (e) {
      setError(e.message);
    } finally {
      summarizeBtn.disabled = false;
      summarizeBtn.innerHTML = '<i class="bi bi-magic"></i> AI summary';
    }
  };
});
// ---- AI Summary (better: add below, not replace)
const summarizeBtn = document.getElementById('summarizeBtn');
summarizeBtn.onclick = async () => {
  try {
    summarizeBtn.disabled = true;
    summarizeBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Summarizing…';

    const text = contentEl.textContent || '';
    const language = languageSelect.value || 'en';

    const r = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language })
    });

    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'Failed to summarize');

    // 🔹 Create/Update summary box
    let summaryBox = document.getElementById('aiSummaryBox');
    if (!summaryBox) {
      summaryBox = document.createElement('div');
      summaryBox.id = 'aiSummaryBox';
      summaryBox.className = 'alert alert-info mt-3';
      contentEl.insertAdjacentElement('afterend', summaryBox);
    }

    summaryBox.innerHTML = `
      <h6 class="mb-2"><i class="bi bi-stars"></i> AI Summary</h6>
      ${j.summary
        .split(/\n{2,}/g)
        .map(p => `<p>${p.trim()}</p>`)
        .join('')}
    `;
  } catch (e) {
    setError(e.message);
  } finally {
    summarizeBtn.disabled = false;
    summarizeBtn.innerHTML = '<i class="bi bi-magic"></i> AI summary';
  }
};



  // PDF Generation Functions
 function generatePDF() {
  if (!window.jspdf) {
    alert("PDF library is still loading. Please try again in a moment.");
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  const title = document.getElementById('resultTitle').textContent;
  const content = document.getElementById('resultContent').textContent;
  const image = document.querySelector('#imageContainer img');
  const url = document.getElementById('fullArticleLink').href;
  const date = new Date().toLocaleDateString();

  // --- COVER PAGE ---
  // Background color block
  doc.setFillColor(230, 240, 255);
  doc.rect(0, 0, doc.internal.pageSize.width, doc.internal.pageSize.height, "F");

  // Decorative box
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(20, 60, 170, 120, 5, 5, "F");

  // Title
  doc.setFont("helvetica", "bold");
  doc.setFontSize(26);
  doc.setTextColor(30, 30, 30);
  doc.text(title, 105, 100, { align: "center", maxWidth: 160 });

  // Subtitle
  doc.setFont("helvetica", "italic");
  doc.setFontSize(14);
  doc.setTextColor(80, 80, 80);
  doc.text("Wikipedia Article Summary", 105, 115, { align: "center" });

  // Date
  doc.setFont("helvetica", "normal");
  doc.setFontSize(12);
  doc.text(`Generated on ${date}`, 105, 130, { align: "center" });

  // Optional logo in cover page (if article has image)
  if (image) {
    try {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      context.drawImage(image, 0, 0);
      const imgData = canvas.toDataURL("image/jpeg", 1.0);

      doc.addImage(imgData, "JPEG", 80, 150, 50, 50 * (image.naturalHeight / image.naturalWidth));
    } catch (e) {
      console.warn("Image skipped on cover:", e);
    }
  }

  // New page for content
  doc.addPage();

  // --- CONTENT PAGE ---
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(20, 20, 20);
  doc.text(title, 15, 25);

  // Insert image on content page (smaller thumbnail at top-left)
  let yOffset = 35;
  if (image) {
    try {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      context.drawImage(image, 0, 0);
      const imgData = canvas.toDataURL("image/jpeg", 1.0);

      const imgWidth = 60;
      const imgHeight = 60 * (image.naturalHeight / image.naturalWidth);
      doc.addImage(imgData, "JPEG", 15, yOffset, imgWidth, imgHeight);

      yOffset += imgHeight + 10;
    } catch (e) {
      console.warn("Image skipped in content:", e);
    }
  }

  // Main content text
  doc.setFont("times", "normal");
  doc.setFontSize(12);
  doc.setTextColor(40, 40, 40);

  const lines = doc.splitTextToSize(content, 180);
  let yPosition = yOffset;

  lines.forEach(line => {
    if (yPosition > 270) {
      doc.addPage();
      yPosition = 20;
    }
    doc.text(line, 15, yPosition);
    yPosition += 7;
  });

  // Footer
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Source: ${url}`, 15, doc.internal.pageSize.height - 10);
    doc.text(`Page ${i} of ${pageCount}`, doc.internal.pageSize.width - 20, doc.internal.pageSize.height - 10, { align: "right" });
  }

  // Save PDF
  doc.save(`${title.substring(0, 30).replace(/[^a-z0-9]/gi, "_")}_Wikipedia.pdf`);
}


 // Set up PDF download button
      if (downloadPdfBtn) {
        downloadPdfBtn.onclick = generatePDF;
        downloadPdfBtn.classList.remove('d-none');
      }

// Register Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js')
      .then(registration => {
        console.log('ServiceWorker registration successful');
      })
      .catch(err => {
        console.log('ServiceWorker registration failed: ', err);
      });
  });
}


// SHARING FUNCTIONS
  

      // Set up PDF download button
      if (downloadPdfBtn) {
        downloadPdfBtn.onclick = generatePDF;
        downloadPdfBtn.classList.remove('d-none');
      }


// Install prompt handling
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  
  // Show install button (add this to your HTML)
  const installBtn = document.createElement('button');
  installBtn.id = 'installBtn';
  installBtn.className = 'btn btn-success position-fixed bottom-0 end-0 m-3';
  installBtn.innerHTML = '<i class="bi bi-download"></i> Install App';
  document.body.appendChild(installBtn);
  
  installBtn.addEventListener('click', () => {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(choiceResult => {
      if (choiceResult.outcome === 'accepted') {
        console.log('User accepted install');
      }
      deferredPrompt = null;
    });
  });
});