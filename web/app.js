const appState = {
  config: null,
  dashboard: null,
  session: null,
  reference: null,
  timer: null,
  timerBase: 0,
  timerBaseMs: 0,
  heartbeatHandle: null,
  localClockHandle: null,
  readerPage: 1,
  pageReads: [],
  pageReadPending: false,
  toastHandle: null,
  targetAlertSessionId: null,
  targetAlertDismissed: false,
  targetAlertToastShown: false,
  targetSoundPlayedForSession: null,
  audioContext: null,
  records: [],
  recordsKind: "sessions",
  recordsPage: 1,
  recordsPageSize: 8,
  selectedRecordKey: null,
};

const $ = (id) => document.getElementById(id);
const api = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
};

const icons = {
  linux: "⌘", calculus: "∫", electronics: "ϟ", algebra: "x²", networking: "⌁",
  python: "Py", go: "Go", c: "C", algorithms: "⌘", "3d-modeling": "◈",
};

function duration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes) return `${minutes}m`;
  return `${total}s`;
}

function clock(seconds) {
  const whole = Math.max(0, Math.floor(Number(seconds || 0)));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return hours
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function renderLocalClock() {
  const timezone = appState.config?.timezone || "America/Bogota";
  const now = new Date();
  $("localClock").textContent = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(now);
  $("localDate").textContent = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, weekday: "short", day: "numeric", month: "short",
  }).format(now);
}

function pdfUrl(reference, page) {
  const base = reference.route.split("#", 1)[0];
  return `/pdfjs/web/viewer.html?file=${encodeURIComponent(base)}#page=${page}`;
}

function bindPdfViewer(frameId) {
  const frame = $(frameId);
  const attach = (attempt = 0) => {
    let application;
    try {
      application = frame.contentWindow?.PDFViewerApplication;
    } catch {
      return;
    }
    if (!application?.eventBus || !application?.pdfViewer) {
      if (attempt < 80) setTimeout(() => attach(attempt + 1), 100);
      return;
    }
    const syncPage = ({ pageNumber } = {}) => {
      const page = Number(pageNumber || application.pdfViewer.currentPageNumber || 1);
      appState.readerPage = page;
      if (frameId === "pdfFrame") {
        $("pdfCurrentPage").textContent = `Current viewer page: ${page}`;
        updatePageReadControl();
      } else if (frameId === "previewPdfFrame") {
        $("startPositionInput").value = String(page);
      }
    };
    application.eventBus.on("pagechanging", syncPage);
    application.eventBus.on("pagesloaded", syncPage);
    syncPage();
  };
  attach();
}

function updatePageReadControl() {
  const control = $("readPageWithCoach");
  if (!control) return;
  const page = Number(appState.readerPage);
  const recorded = appState.pageReads.some((item) => Number(item.viewer_page) === page);
  const loaded = Boolean($("pdfFrame").contentWindow?.PDFViewerApplication?.pdfDocument);
  control.checked = recorded;
  control.disabled = appState.pageReadPending || !loaded || !page || recorded || $("sendButton").disabled;
  $("pageReadLabel").textContent = recorded ? "Page recorded" : "Mark this page as read";
  const requiresPage = appState.session?.reference_kind === "book" && appState.session?.mode !== "assessment";
  const needsReadPage = requiresPage && appState.pageReads.length === 0;
  $("finishButton").disabled = Boolean(needsReadPage || appState.pageReadPending);
  $("pdfFinishHint").textContent = appState.pageReadPending
    ? "Wait for this page to finish saving before ending the session."
    : "Mark at least one PDF page as read to finish and log this lesson.";
  $("pdfFinishHint").classList.toggle("hidden", !needsReadPage && !appState.pageReadPending);
}

function setPdfPage(reference, page, frameId, inputId, labelId) {
  const requested = Number(page);
  if (!Number.isInteger(requested) || requested < 1) {
    toast("Enter a positive PDF page number.");
    return;
  }
  appState.readerPage = requested;
  if (inputId) $(inputId).value = String(requested);
  if (labelId) $(labelId).textContent = `Page ${requested}`;
  $(frameId).src = pdfUrl(reference, requested);
  if (frameId === "previewPdfFrame") $("startPositionInput").value = String(requested);
}

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  if (node.matches(":popover-open")) node.hidePopover();
  node.showPopover();
  clearTimeout(appState.toastHandle);
  appState.toastHandle = setTimeout(() => {
    if (node.matches(":popover-open")) node.hidePopover();
  }, 3400);
}

function promoteToast() {
  const node = $("toast");
  if (!node.matches(":popover-open")) return;
  const message = node.textContent;
  node.hidePopover();
  node.textContent = message;
  node.showPopover();
}

function openModal(dialog) {
  if (!dialog.open) dialog.showModal();
  promoteToast();
  notifyTargetAlertAboveModal();
}

function notifyTargetAlertAboveModal() {
  const alert = $("targetAlert");
  if (!alert || alert.classList.contains("hidden") || appState.targetAlertToastShown) return;
  if (!document.querySelector('dialog[open]:not(#toast)')) return;
  appState.targetAlertToastShown = true;
  toast(alert.querySelector("span").textContent);
}

async function loadConfig() {
  appState.config = await api("/api/config");
  $("timezoneLabel").textContent = appState.config.timezone;
  $("libraryCount").textContent = `${appState.config.topics.length} topics · choose any time`;
  fillTopicSelect();
  renderLibrary();
}

async function loadDashboard() {
  appState.config = await api("/api/config");
  appState.dashboard = await api("/api/dashboard");
  const data = appState.dashboard;
  $("totalTime").textContent = duration(data.total_seconds);
  $("totalSessions").textContent = data.total_sessions;
  $("totalSolved").textContent = data.exercises_solved;
  $("weekTime").textContent = duration(data.week_seconds);
  renderLibrary();
  renderHistory();
}

async function loadAuth() {
  const button = $("authButton");
  button.disabled = true;
  button.textContent = "Connecting…";
  try {
    const status = await api("/api/auth/status");
    if (status.authenticated) {
      button.textContent = status.plan ? `Codex · ${status.plan}` : "Codex connected";
      button.classList.add("auth-connected");
      button.disabled = false;
      button.title = "Signed in with ChatGPT; Codex plan usage applies.";
      return true;
    }
    button.textContent = "Connect ChatGPT";
    button.classList.remove("auth-connected");
    button.disabled = false;
    if (status.error) button.title = status.error;
    return false;
  } catch (error) {
    button.textContent = "Connect ChatGPT";
    button.disabled = false;
    button.title = error.message;
    return false;
  }
}

function fillTopicSelect(selectedTopic) {
  const topicSelect = $("topicSelect");
  const previous = selectedTopic || topicSelect.value;
  topicSelect.replaceChildren();
  for (const topic of appState.config.topics) {
    const option = document.createElement("option");
    option.value = topic.id;
    option.textContent = topic.title;
    topicSelect.append(option);
  }
  if (previous && appState.config.topics.some((topic) => topic.id === previous)) {
    topicSelect.value = previous;
  }
  populateReferences();
}

function populateReferences(selectedReference) {
  const topic = (appState.config?.topics || []).find((item) => item.id === $("topicSelect").value);
  const select = $("referenceSelect");
  select.replaceChildren();
  for (const reference of topic?.references || []) {
    const option = document.createElement("option");
    option.value = reference.id;
    option.textContent = reference.title;
    option.dataset.kind = reference.kind;
    select.append(option);
  }
  if (selectedReference && [...select.options].some((option) => option.value === selectedReference)) {
    select.value = selectedReference;
  }
  syncModeFields();
}

function currentReference() {
  const topic = (appState.config?.topics || []).find((item) => item.id === $("topicSelect").value);
  return topic?.references.find((item) => item.id === $("referenceSelect").value) || null;
}

function renderLibrary() {
  if (!appState.config) return;
  const totals = new Map((appState.dashboard?.topics || []).map((item) => [item.topic_id, item]));
  const grid = $("topicGrid");
  grid.replaceChildren();
  for (const topic of appState.config.topics) {
    const total = totals.get(topic.id) || { seconds: 0, sessions: 0, references: [] };
    const card = document.createElement("article");
    card.className = "topic-card";
    const head = document.createElement("div");
    head.className = "topic-card-head";
    const icon = document.createElement("span");
    icon.className = "topic-icon";
    icon.textContent = icons[topic.id] || "✦";
    const title = document.createElement("div");
    title.innerHTML = `<div class="topic-name"></div><div class="topic-total"></div>`;
    title.querySelector(".topic-name").textContent = topic.title;
    title.querySelector(".topic-total").textContent = `${duration(total.seconds)} studied · ${total.sessions} sessions`;
    head.append(icon, title);
    const list = document.createElement("div");
    list.className = "reference-list";
    for (const reference of topic.references) {
      const refTotal = (total.references || []).find((item) => item.id === reference.id);
      const row = document.createElement("div");
      row.className = "reference-row";
      const info = document.createElement("div");
      const refTitle = document.createElement("span");
      refTitle.className = "reference-title";
      refTitle.textContent = reference.title;
      const meta = document.createElement("div");
      meta.className = `reference-meta${reference.available ? "" : " unavailable"}`;
      meta.textContent = `${reference.kind === "book" ? "BOOK" : "VIDEO"} · ${reference.progress}${reference.available ? "" : " · file unavailable"}`;
      info.append(refTitle, meta);
      const action = document.createElement("div");
      action.className = "reference-action";
      const time = document.createElement("div");
      time.className = "reference-time";
      time.textContent = duration(refTotal?.seconds || 0);
      const start = document.createElement("button");
      start.type = "button";
      start.className = "start-reference";
      start.textContent = "Start lesson →";
      start.disabled = !reference.available;
      start.addEventListener("click", () => openSetup(topic.id, reference.id));
      action.append(time, start);
      row.append(info, action);
      list.append(row);
    }
    card.append(head, list);
    grid.append(card);
  }
}

function renderHistory() {
  const node = $("historyList");
  node.replaceChildren();
  const history = appState.dashboard?.history || [];
  if (!history.length) {
    node.innerHTML = '<div class="empty-state">Your first lesson will appear here. There is no fixed start time—begin whenever it suits you.</div>';
    return;
  }
  const head = document.createElement("div");
  head.className = "history-row history-header";
  head.innerHTML = "<span>TOPIC / REFERENCE</span><span>SESSION DATE</span><span>TIME</span><span>RESULT</span>";
  node.append(head);
  for (const item of history) {
    const row = document.createElement("div");
    row.className = "history-row";
    const topic = document.createElement("div");
    topic.innerHTML = '<div class="history-title"></div><div class="history-sub"></div>';
    topic.querySelector(".history-title").textContent = item.topic_title;
    topic.querySelector(".history-sub").textContent = item.reference_title;
    const date = document.createElement("span");
    date.textContent = new Date(item.started_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    const time = document.createElement("span");
    time.textContent = duration(item.elapsed_seconds);
    const status = document.createElement("span");
    status.className = "history-status";
    const pill = document.createElement("span");
    pill.className = `status-pill ${item.status === "paused" ? "paused" : ""}`;
    pill.textContent = item.mode === "assessment" ? (item.score == null ? item.status : `${item.score}/10`) : item.status;
    status.append(pill);
    if (["active", "paused"].includes(item.status)) {
      const continueButton = document.createElement("button");
      continueButton.type = "button";
      continueButton.className = "history-continue";
      continueButton.textContent = "Continue →";
      continueButton.addEventListener("click", () => continueSession(item.id).catch((error) => toast(error.message)));
      status.append(continueButton);
    }
    row.append(topic, date, time, status);
    node.append(row);
  }
}

function syncModeFields() {
  const assessment = $("modeSelect").value === "assessment";
  const hasTimeGoal = $("durationSelect").value !== "open";
  $("setupTitle").textContent = assessment ? "Set up a practice test" : "Choose your lesson";
  $("prepareButton").textContent = assessment ? "Start closed-book test →" : "Open reference →";
  const reference = currentReference();
  $("setupIntro").textContent = assessment
    ? "Choose a topic and reference for a closed-book practice test. The reference stays closed; the timer starts when you begin."
    : reference?.kind === "book"
      ? "Choose a topic and reference. The PDF will open right here in Study Room. Find your starting page, then enter it and begin whenever you’re ready. Choose any time target or leave it open-ended."
      : "Choose a topic and reference. The video will open in another tab. Return here when you’re ready and enter its starting time to begin. Choose any time target or leave it open-ended.";
  $("customDurationWrap").classList.toggle("hidden", $("durationSelect").value !== "custom");
  $("soundReminderWrap").classList.toggle("hidden", !hasTimeGoal);
  if (!hasTimeGoal) $("soundReminder").checked = false;
}

function openSetup(topicId, referenceId) {
  fillTopicSelect(topicId);
  if (referenceId) populateReferences(referenceId);
  $("modeSelect").value = "lesson";
  $("durationSelect").value = "open";
  $("soundReminder").checked = false;
  syncModeFields();
  openModal($("setupDialog"));
}

function selectedMinutes() {
  const value = $("durationSelect").value;
  if (value === "open") return "open";
  if (value === "custom") return $("customDuration").value;
  return value;
}

function prepareTargetSound() {
  if (!$("soundReminder").checked) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  try {
    appState.audioContext ||= new AudioContextClass();
    appState.audioContext.resume().catch(() => {});
  } catch (_error) {
    appState.audioContext = null;
  }
}

function playTargetSound() {
  const context = appState.audioContext;
  if (!context || context.state !== "running") return;
  try {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(660, context.currentTime);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.42);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.45);
  } catch (_error) {
    // The visual reminder remains available if the browser blocks audio.
  }
}

function showPositioning(reference) {
  appState.reference = reference;
  $("positionTitle").textContent = "Find where you want to begin.";
  const isBook = reference.kind === "book";
  $("startPositionLabel").firstChild.textContent = isBook ? "Starting PDF viewer page" : "Starting video time (MM:SS)";
  const saved = reference.progress.startsWith("PDF page ")
    ? reference.progress.replace("PDF page ", "")
    : reference.progress.match(/\d{2}:\d{2}/)?.[0] || "00:00";
  $("startPositionInput").value = isBook && saved === "Page not set" ? "" : saved;
  $("startPositionInput").placeholder = isBook ? "e.g. 42" : "e.g. 03:25";
  $("positionHint").textContent = isBook
    ? "Use the PDF viewer page number shown by the reader, not the printed page label."
    : "Use the video player time where you will start practicing.";
  $("openSessionCard").classList.add("hidden");
  $("positionIntro").textContent = isBook
    ? "The PDF is open below. Use its built-in controls to find your starting page, enter that viewer page number below, then select Begin lesson. The study timer starts when you begin."
    : `The video “${reference.title}” opens in another tab. Find your starting time there, return here, enter it, then select Begin lesson. The study timer starts when you begin.`;
  $("startPositionInput").required = isBook;
  $("previewReader").classList.toggle("hidden", !isBook);
  if (isBook) {
    const startPage = Number($("startPositionInput").value) || 1;
    setPdfPage(reference, startPage, "previewPdfFrame");
  } else {
    openReferenceTab(reference);
  }
  updateOpenSessionCard();
  $("beginButton").disabled = false;
  $("beginButton").textContent = "Begin lesson →";
  openModal($("positionDialog"));
}

function openReferenceTab(reference) {
  const target = window.open(reference.route, "_blank", "noopener");
  if (!target) toast("Your browser blocked the reference tab. Allow pop-ups for this local dashboard.");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function renderInlineMarkdown(text) {
  let html = escapeHtml(text);
  const codeSpans = [];
  html = html.replace(/`([^`\n]+)`/g, (_match, code) => {
    codeSpans.push(`<code>${code}</code>`);
    return `%%INLINECODE${codeSpans.length - 1}%%`;
  });
  html = html
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  return html.replace(/%%INLINECODE(\d+)%%/g, (_match, index) => codeSpans[Number(index)]);
}

function renderMarkdown(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let paragraph = [];
  let listItems = [];
  let listTag = "";
  let codeLines = null;
  let codeLanguage = "";

  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${paragraph.map(renderInlineMarkdown).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listItems.length) return;
    output.push(`<${listTag}>${listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${listTag}>`);
    listItems = [];
    listTag = "";
  };
  const tableCells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "")
    .split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
  const isTableDivider = (line) => {
    const cells = tableCells(line);
    return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      flushParagraph();
      flushList();
      if (codeLines) {
        const languageClass = codeLanguage ? ` class="language-${codeLanguage}"` : "";
        output.push(`<pre><code${languageClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = null;
        codeLanguage = "";
      } else {
        codeLines = [];
        codeLanguage = fence[1];
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(line);
      continue;
    }
    if (line.includes("|") && lines[lineIndex + 1] && isTableDivider(lines[lineIndex + 1])) {
      flushParagraph();
      flushList();
      const headers = tableCells(line);
      lineIndex += 1;
      const rows = [];
      while (lineIndex + 1 < lines.length && lines[lineIndex + 1].includes("|")) {
        lineIndex += 1;
        rows.push(tableCells(lines[lineIndex]));
      }
      const headerHtml = headers.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("");
      const bodyHtml = rows.map((row) => `<tr>${headers.map((_cell, index) => `<td>${renderInlineMarkdown(row[index] || "")}</td>`).join("")}</tr>`).join("");
      output.push(`<div class="markdown-table-wrap"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`);
      continue;
    }
    if (/^\s*<!--.*-->\s*$/.test(line)) continue;
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(/^#{1,4}\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      output.push(`<h3>${renderInlineMarkdown(heading[1])}</h3>`);
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextTag = unordered ? "ul" : "ol";
      if (listTag && listTag !== nextTag) flushList();
      listTag = nextTag;
      listItems.push((unordered || ordered)[1]);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  if (codeLines) output.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  return output.join("");
}

async function readStudyRecord(record, selectedButton) {
  appState.selectedRecordKey = record.kind === "chats" ? record.session_id : record.filename;
  $("recordsList").querySelectorAll(".record-item").forEach((button) => button.classList.remove("selected"));
  selectedButton?.classList.add("selected");
  const content = $("recordContent");
  content.replaceChildren();
  const loading = document.createElement("div");
  loading.className = "record-placeholder";
  loading.textContent = "Loading record…";
  content.append(loading);
  try {
    const recordKey = record.kind === "chats" ? record.session_id : record.filename;
    const data = await api(`/api/records/${record.kind}/${encodeURIComponent(recordKey)}`);
    const label = document.createElement("div");
    label.className = "record-type";
    if (record.kind === "chats") {
      label.textContent = `COACH CONVERSATION · ${record.date}`;
      const transcript = document.createElement("div");
      transcript.className = "chat-record-transcript";
      for (const message of data.messages) {
        const turn = document.createElement("section");
        turn.className = `chat-record-turn ${message.role}`;
        const speaker = document.createElement("div");
        speaker.className = "chat-record-speaker";
        speaker.textContent = message.role === "assistant" ? "Study Coach" : "You";
        const body = document.createElement("div");
        body.className = "chat-record-body markdown-document";
        body.innerHTML = renderMarkdown(message.content);
        turn.append(speaker, body);
        transcript.append(turn);
      }
      if (!data.messages.length) {
        const empty = document.createElement("div");
        empty.className = "record-placeholder";
        empty.textContent = "This session has no saved chat messages.";
        transcript.append(empty);
      }
      content.replaceChildren(label, transcript);
    } else {
      label.textContent = record.kind === "weekly" ? "WEEKLY SUMMARY" : "SESSION LOG";
      if (record.kind === "sessions") {
        const pages = data.page_reads || [];
        const sectionStart = data.content.indexOf("\n## Pages read\n");
        const hasSummarySection = sectionStart >= 0;
        const rawSummaryMarkdown = hasSummarySection ? data.content.slice(sectionStart).trim() : "";
        const trailingNotes = rawSummaryMarkdown.match(/\n(- Score:.*(?:\r?\n- Grade notes:.*)?\s*)$/)?.[1] || "";
        const summaryMarkdown = rawSummaryMarkdown.replace(/\n- Score:[\s\S]*$/, "");
        let logMarkdown = hasSummarySection
          ? `${data.content.slice(0, sectionStart).trimEnd()}${trailingNotes ? `\n${trailingNotes.trim()}` : ""}`
          : data.content;
        if (pages.length) {
          logMarkdown = logMarkdown.replace(/^- Concepts:\r?\n(?:[ \t]+- .*\r?\n?)*/m, "");
        }
        const hasSummaries = pages.length > 0 || hasSummarySection;
        const viewButton = document.createElement("button");
        viewButton.type = "button";
        viewButton.className = "record-summary-toggle";
        viewButton.setAttribute("aria-controls", "recordSummaryView");
        viewButton.setAttribute("aria-expanded", "false");
        const documentView = document.createElement("div");
        documentView.className = "markdown-document";
        documentView.id = "recordSummaryView";
        let showingSummaries = false;
        const renderCurrentView = () => {
          if (!showingSummaries) {
            documentView.innerHTML = renderMarkdown(logMarkdown);
            viewButton.textContent = hasSummaries
              ? `Show page summaries${pages.length ? ` (${pages.length})` : ""}`
              : "No page summaries recorded";
            viewButton.disabled = !hasSummaries;
            return;
          }
          if (!pages.length) {
            documentView.innerHTML = renderMarkdown(summaryMarkdown);
            return;
          }
          documentView.replaceChildren();
          for (const page of pages) {
            const pageSection = document.createElement("section");
            pageSection.className = "record-page-summary";
            const heading = document.createElement("h3");
            heading.textContent = `PDF viewer page ${page.viewer_page}${page.printed_page ? ` · printed page ${page.printed_page}` : ""}`;
            const summary = document.createElement("div");
            summary.className = "markdown-document";
            summary.innerHTML = renderMarkdown(page.summary);
            pageSection.append(heading, summary);
            const concepts = (page.concepts || []).slice(0, 3);
            if (concepts.length) {
              const conceptHeading = document.createElement("h4");
              conceptHeading.textContent = "Key concepts";
              const list = document.createElement("ul");
              for (const concept of concepts) {
                const item = document.createElement("li");
                item.textContent = concept;
                list.append(item);
              }
              pageSection.append(conceptHeading, list);
            }
            documentView.append(pageSection);
          }
        };
        viewButton.addEventListener("click", () => {
          showingSummaries = !showingSummaries;
          viewButton.setAttribute("aria-expanded", String(showingSummaries));
          viewButton.textContent = showingSummaries ? "Back to session log" : `Show page summaries (${pages.length})`;
          documentView.innerHTML = "";
          renderCurrentView();
        });
        renderCurrentView();
        content.replaceChildren(label, ...(hasSummaries ? [viewButton] : []), documentView);
      } else {
        const documentView = document.createElement("div");
        documentView.className = "markdown-document";
        documentView.innerHTML = renderMarkdown(data.content);
        content.replaceChildren(label, documentView);
      }
    }
  } catch (error) {
    content.replaceChildren();
    const message = document.createElement("div");
    message.className = "record-placeholder record-load-error";
    message.textContent = error.message;
    content.append(message);
  }
}

function recordKey(record) {
  return record.kind === "chats" ? record.session_id : record.filename;
}

function renderRecordList(autoSelect = false) {
  const list = $("recordsList");
  const kind = appState.recordsKind;
  let records = appState.records.filter((record) => record.kind === kind);
  if (kind !== "weekly") {
    const topic = $("recordTopicFilter").value;
    const from = $("recordDateFrom").value;
    const to = $("recordDateTo").value;
    records = records.filter((record) =>
      (!topic || record.topic === topic)
      && (!from || (record.date && record.date >= from))
      && (!to || (record.date && record.date <= to))
    );
  }

  const pageCount = Math.max(1, Math.ceil(records.length / appState.recordsPageSize));
  appState.recordsPage = Math.min(appState.recordsPage, pageCount);
  const start = (appState.recordsPage - 1) * appState.recordsPageSize;
  const visible = records.slice(start, start + appState.recordsPageSize);
  list.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "record-placeholder";
    empty.textContent = records.length ? "No records on this page." : "No records match these filters.";
    list.append(empty);
    $("recordContent").innerHTML = '<div class="record-placeholder">Choose another tab or adjust the filters.</div>';
    appState.selectedRecordKey = null;
  }

  for (const record of visible) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "record-item";
    button.innerHTML = '<span class="record-item-title"></span><small class="record-item-date"></small>';
    button.querySelector(".record-item-title").textContent = record.title;
    button.querySelector(".record-item-date").textContent = record.date || record.filename.replace(/\.md$/, "");
    button.addEventListener("click", () => readStudyRecord(record, button));
    list.append(button);
  }

  const selectedIndex = visible.findIndex((record) => recordKey(record) === appState.selectedRecordKey);
  if (autoSelect || (visible.length && selectedIndex < 0)) {
    if (visible.length) readStudyRecord(visible[0], list.querySelector(".record-item"));
  } else if (selectedIndex >= 0) {
    const button = list.querySelectorAll(".record-item")[selectedIndex];
    button.classList.add("selected");
  }

  const firstNumber = records.length ? start + 1 : 0;
  const lastNumber = Math.min(start + appState.recordsPageSize, records.length);
  $("recordPageInfo").textContent = records.length
    ? `Showing ${firstNumber}–${lastNumber} of ${records.length} · Page ${appState.recordsPage} of ${pageCount}`
    : "0 records";
  $("recordsPrevPage").disabled = appState.recordsPage <= 1;
  $("recordsNextPage").disabled = appState.recordsPage >= pageCount;
  $("recordFilters").classList.toggle("hidden", kind === "weekly");
}

async function openStudyRecords() {
  const dialog = $("recordsDialog");
  appState.recordsKind = "sessions";
  dialog.querySelectorAll(".record-tab").forEach((tab) => {
    const selected = tab.dataset.recordKind === appState.recordsKind;
    tab.classList.toggle("selected", selected);
    tab.setAttribute("aria-selected", String(selected));
  });
  $("recordsList").replaceChildren();
  $("recordContent").innerHTML = '<div class="record-placeholder">Loading study records…</div>';
  if (!dialog.open) openModal(dialog);
  try {
    const data = await api("/api/records");
    appState.records = data.records;
    appState.recordsKind = ["sessions", "chats", "weekly"].find((kind) => data.records.some((record) => record.kind === kind)) || "sessions";
    appState.recordsPage = 1;
    appState.selectedRecordKey = null;
    dialog.querySelectorAll(".record-tab").forEach((tab) => {
      const selected = tab.dataset.recordKind === appState.recordsKind;
      tab.classList.toggle("selected", selected);
      tab.setAttribute("aria-selected", String(selected));
    });
    const topics = [...new Set(data.records.map((record) => record.topic).filter(Boolean))].sort();
    const topicFilter = $("recordTopicFilter");
    topicFilter.replaceChildren(new Option("All topics", ""));
    for (const topic of topics) topicFilter.append(new Option(topic, topic));
    $("recordDateFrom").value = "";
    $("recordDateTo").value = "";
    renderRecordList(true);
  } catch (error) {
    $("recordContent").textContent = error.message;
  }
}

async function clearStudyRecords(event) {
  event.preventDefault();
  const confirmButton = $("confirmClearRecords");
  const status = $("clearRecordsStatus");
  confirmButton.disabled = true;
  status.textContent = "Clearing saved study records…";
  try {
    const result = await api("/api/records/clear", {
      method: "POST",
      body: JSON.stringify({}),
    });
    $("clearRecordsDialog").close();
    status.textContent = "";
    if (result.export_errors) {
      toast(`Database cleared, but ${result.export_errors} generated file(s) could not be deleted.`);
    } else {
      toast(`Study records cleared. Removed ${result.sessions} session(s) and ${result.exports} generated file(s).`);
    }
    try {
      await loadDashboard();
      await openStudyRecords();
    } catch {
      toast("Records were cleared, but the dashboard could not refresh. Reload the page to update it.");
    }
  } catch (error) {
    status.textContent = error.message;
  } finally {
    confirmButton.disabled = false;
  }
}

function appendMessage(role, text, imageDataUrl = null) {
  const container = $("chatMessages");
  container.querySelector(".empty-chat")?.remove();
  const message = document.createElement("div");
  message.className = `message ${role}`;
  const meta = document.createElement("span");
  meta.className = "message-meta";
  meta.textContent = role === "assistant" ? "Study Coach" : "You";
  const content = document.createElement("div");
  if (role === "assistant") content.innerHTML = renderMarkdown(text);
  else {
    content.textContent = text;
    if (imageDataUrl) {
      const image = document.createElement("img");
      image.className = "chat-page-attachment";
      image.src = imageDataUrl;
      image.alt = "PDF viewer page shared with Study Coach";
      content.append(image);
    }
  }
  message.append(meta, content);
  container.append(message);
  container.scrollTop = container.scrollHeight;
  return content;
}

async function streamChat(sessionId, text, initial = false, imageDataUrl = null, pageNumber = null) {
  const send = $("sendButton");
  const status = $("coachStatus");
  if (!initial) appendMessage("user", text, imageDataUrl);
  send.disabled = true;
  updatePageReadControl();
  status.textContent = "Thinking through your lesson…";
  let assistantNode = null;
  let assistantText = "";
  try {
    const response = await fetch(`/api/session/${sessionId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, ...(imageDataUrl ? { image_data_url: imageDataUrl, page_number: pageNumber } : {}) }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Coach request failed (${response.status}).`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const packets = buffer.split("\n\n");
      buffer = packets.pop() || "";
      for (const packet of packets) {
        const eventLine = packet.split("\n").find((line) => line.startsWith("event: "));
        const dataLine = packet.split("\n").find((line) => line.startsWith("data: "));
        if (!eventLine || !dataLine) continue;
        const eventName = eventLine.slice(7);
        const data = JSON.parse(dataLine.slice(6));
        if (eventName === "delta") {
          if (!assistantNode) assistantNode = appendMessage("assistant", "");
          assistantText += data.text || "";
          assistantNode.innerHTML = renderMarkdown(assistantText);
          $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
        } else if (eventName === "activity") {
          status.textContent = "Preparing your next step…";
        } else if (eventName === "error") {
          throw new Error(data.error || "The tutor response failed.");
        } else if (eventName === "complete") {
          status.textContent = data.status === "completed" ? "Here with you" : `Tutor turn ${data.status}`;
        }
      }
    }
    if (!assistantText) status.textContent = "The tutor finished without a text reply.";
    await loadDashboard();
  } catch (error) {
    appendMessage("error", error.message);
    status.textContent = "Connection needs attention";
    if (document.querySelector('dialog[open]:not(#toast)')) toast(error.message);
  } finally {
    send.disabled = false;
    updatePageReadControl();
    $("chatInput").focus();
  }
}

async function markCurrentPageRead() {
  if (!appState.session || !appState.reference || appState.reference.kind !== "book") return;
  if ($("sendButton").disabled || appState.pageReadPending) return;
  const viewer = $("pdfFrame").contentWindow?.PDFViewerApplication;
  const pageNumber = Number(viewer?.pdfViewer?.currentPageNumber || 0);
  if (!viewer?.pdfDocument || !Number.isInteger(pageNumber) || pageNumber < 1) {
    toast("The PDF page is still loading. Try again in a moment.");
    return;
  }
  const control = $("readPageWithCoach");
  if (appState.pageReads.some((item) => Number(item.viewer_page) === pageNumber)) return;
  appState.pageReadPending = true;
  $("sendButton").disabled = true;
  $("chatInput").disabled = true;
  control.checked = false;
  updatePageReadControl();
  $("pageReadLabel").textContent = "Saving progress…";
  try {
    const page = await viewer.pdfDocument.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => `${item.str || ""}${item.hasEOL ? "\n" : " "}`)
      .join("")
      .replace(/[\t ]+/g, " ")
      .trim()
      .slice(0, 20000);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(1.8, 1900 / Math.max(baseViewport.width, baseViewport.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
    const imageDataUrl = canvas.toDataURL("image/jpeg", 0.86);
    const response = await fetch(`/api/session/${appState.session.id}/read-page`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page_number: pageNumber, page_text: pageText, image_data_url: imageDataUrl }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Could not save this page (${response.status}).`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let recorded = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const packets = buffer.split("\n\n");
      buffer = packets.pop() || "";
      for (const packet of packets) {
        const eventLine = packet.split("\n").find((line) => line.startsWith("event: "));
        const dataLine = packet.split("\n").find((line) => line.startsWith("data: "));
        if (!eventLine || !dataLine) continue;
        const eventName = eventLine.slice(7);
        const data = JSON.parse(dataLine.slice(6));
        if (eventName === "error") throw new Error(data.error || "Could not save this page.");
        if (eventName === "page_recorded") {
          recorded = true;
          appState.pageReads.push({ viewer_page: data.viewer_page, printed_page: data.printed_page });
          appState.session.page_reads = appState.pageReads;
          if (data.exercise_message) appendMessage("assistant", data.exercise_message);
          updatePageReadControl();
          toast(`PDF viewer page ${data.viewer_page} saved to this session.`);
        }
      }
    }
    if (!recorded) throw new Error("Could not save this page. Please try again.");
  } catch (error) {
    control.checked = false;
    toast(error.message);
  } finally {
    appState.pageReadPending = false;
    $("sendButton").disabled = false;
    $("chatInput").disabled = false;
    updatePageReadControl();
  }
}

function showSession(session, messages = []) {
  appState.session = session;
  appState.pageReads = session.page_reads || [];
  appState.pageReadPending = false;
  if (appState.targetAlertSessionId !== session.id) {
    appState.targetAlertSessionId = session.id;
    appState.targetAlertDismissed = false;
    appState.targetAlertToastShown = false;
    appState.targetSoundPlayedForSession = null;
  }
  $("timerCard").classList.remove("target-reached");
  $("targetAlert").classList.add("hidden");
  $("appShell").classList.add("session-expanded");
  appState.reference = appState.config.topics
    .find((topic) => topic.id === session.topic_id)?.references
    .find((reference) => reference.id === session.reference_id) || null;
  $("dashboardView").classList.add("hidden");
  $("sessionView").classList.remove("hidden");
  $("openDashboard").classList.remove("hidden");
  $("sessionTopicLabel").textContent = session.topic_title.toUpperCase();
  $("sessionTitle").textContent = session.topic_title;
  $("sessionReference").textContent = session.reference_title;
  $("sessionModeBadge").textContent = session.mode === "assessment" ? "PRACTICE TEST" : "GUIDED STUDY";
  const hasPdf = session.reference_kind === "book" && session.mode !== "assessment";
  const needsReadPage = hasPdf && appState.pageReads.length === 0;
  const hasVideo = session.reference_kind === "video" && session.mode !== "assessment";
  $("pdfReader").classList.toggle("hidden", !hasPdf);
  $("readPageWithCoach").disabled = true;
  $("pdfFinishHint").classList.toggle("hidden", !needsReadPage);
  $("finishButton").disabled = needsReadPage;
  $("pdfCurrentPage").textContent = "Current viewer page: loading…";
  $("videoReader").classList.toggle("hidden", !hasVideo);
  $("assessmentReader").classList.toggle("hidden", session.mode !== "assessment");
  $("studyWorkspace").classList.remove("panel-hidden");
  $("toggleStudyPanel").textContent = "Hide study panel";
  $("toggleStudyPanel").setAttribute("aria-expanded", "true");
  if (hasPdf && appState.reference) {
    const startPage = Number(session.start_position) || 1;
    setPdfPage(appState.reference, startPage, "pdfFrame");
  }
  updatePageReadControl();
  const label = session.reference_kind === "book" ? "PDF page" : "Video position";
  $("sessionStartPosition").textContent = session.start_position ? `${label} ${session.start_position}` : "Closed book · no reference open";
  $("targetLabel").textContent = session.planned_seconds ? `Target ${duration(session.planned_seconds)}` : "Open-ended";
  $("timerFootnote").textContent = session.planned_seconds
    ? "The target is a guide, not a hard stop. Continue or finish whenever you like."
    : "Open-ended session. Pause whenever you step away; only active time is counted.";
  $("finishButton").textContent = session.mode === "assessment" ? "Finish & grade" : "Finish & log";
  $("chatMessages").replaceChildren();
  if (messages.length) {
    for (const message of messages) appendMessage(message.role, message.content);
  } else {
    const empty = document.createElement("div");
    empty.className = "empty-chat";
    empty.innerHTML = hasPdf
      ? "<span>✳</span><p>Read at your pace.</p><small>Mark each PDF page after reading it. Ask the Coach when you want help with the material.</small>"
      : "<span>✳</span><p>Your lesson is ready.</p><small>Ask the Coach about the selected topic whenever you want help.</small>";
    $("chatMessages").append(empty);
  }
  $("chatInput").disabled = false;
  $("sendButton").disabled = false;
  syncTimer(session);
  if (session.status === "paused") {
    $("pauseButton").textContent = "Resume";
    $("coachStatus").textContent = "Session paused";
  } else {
    $("pauseButton").textContent = "Pause";
    $("coachStatus").textContent = messages.length ? "Here with you" : "Ready when you are";
  }
  if (appState.heartbeatHandle) clearInterval(appState.heartbeatHandle);
  appState.heartbeatHandle = setInterval(async () => {
    if (appState.session?.status !== "active") return;
    try {
      const data = await api(`/api/session/${session.id}/heartbeat`, { method: "POST", body: "{}" });
      appState.session = data.session;
      appState.timerBase = data.session.elapsed_seconds;
      appState.timerBaseMs = Date.now();
    } catch (error) {
      console.warn("Study timer heartbeat failed", error);
    }
  }, 12000);
}

function syncTimer(session) {
  clearInterval(appState.timer);
  appState.timerBase = Number(session.elapsed_seconds || 0);
  appState.timerBaseMs = Date.now();
  appState.timer = setInterval(renderTimer, 250);
  renderTimer();
}

function renderTimer() {
  if (!appState.session) return;
  const running = appState.session.status === "active";
  const elapsed = appState.timerBase + (running ? Math.floor((Date.now() - appState.timerBaseMs) / 1000) : 0);
  $("timerDisplay").textContent = clock(elapsed);
  const target = Number(appState.session.planned_seconds || 0);
  $("timerProgress").style.width = target ? `${Math.min(100, elapsed / target * 100)}%` : "0%";
  if (target && elapsed >= target) {
    $("targetLabel").textContent = "Time goal reached";
    if (!appState.targetAlertDismissed) {
      $("timerCard").classList.add("target-reached");
      $("targetAlert").classList.remove("hidden");
      notifyTargetAlertAboveModal();
    }
    if (appState.session.sound_on_target && appState.targetSoundPlayedForSession !== appState.session.id) {
      appState.targetSoundPlayedForSession = appState.session.id;
      playTargetSound();
    }
  } else if (target) {
    $("targetLabel").textContent = `Goal ${duration(target)}`;
  } else {
    $("targetLabel").textContent = "Open session";
  }
}

async function restoreSession(sessionId) {
  const data = await api("/api/session/active");
  if (!data.session || data.session.id !== sessionId) return;
  const messages = await api(`/api/session/${sessionId}/messages`);
  showSession(data.session, messages.messages);
}

async function beginSession(mode, startPosition) {
  const reference = currentReference();
  const payload = {
    topic_id: $("topicSelect").value,
    reference_id: reference.id,
    planned_minutes: selectedMinutes(),
    start_position: startPosition,
    mode,
    sound_on_target: selectedMinutes() !== "open" && $("soundReminder").checked,
  };
  let response;
  try {
    response = await api("/api/session/start", { method: "POST", body: JSON.stringify(payload) });
  } catch (error) {
    if (error.message.includes("current session")) {
      await updateOpenSessionCard();
    }
    throw error;
  }
  $("setupDialog").close();
  $("positionDialog").close();
  showSession(response.session);
  if (mode === "assessment") await streamChat(response.session.id, "", true);
  await loadDashboard();
}

async function restoreOpenSession() {
  const active = await api("/api/session/active");
  if (!active.session) return false;
  if ($("positionDialog").open) $("positionDialog").close();
  if ($("setupDialog").open) $("setupDialog").close();
  showSession(active.session, active.session.messages || []);
  return true;
}

async function continueSession(sessionId = null) {
  const active = await api("/api/session/active");
  if (!active.session || (sessionId && active.session.id !== sessionId)) {
    throw new Error("There is no open session to continue.");
  }
  if ($("positionDialog").open) $("positionDialog").close();
  if ($("setupDialog").open) $("setupDialog").close();
  showSession(active.session, active.session.messages || []);
  if (active.session.status === "paused") await pauseOrResume();
}

async function updateOpenSessionCard() {
  const card = $("openSessionCard");
  try {
    const active = await api("/api/session/active");
    const session = active.session;
    if (!session) {
      card.classList.add("hidden");
      return false;
    }
    $("openSessionHeading").textContent = session.status === "paused"
      ? "You have a paused study session"
      : "You already have a study session in progress";
    $("openSessionDetails").textContent = `${session.topic_title} · ${session.reference_title}. Continue this session, or finish it before starting another.`;
    card.classList.remove("hidden");
    return true;
  } catch (error) {
    card.classList.add("hidden");
    console.warn("Could not check for an open study session", error);
    return false;
  }
}

function addExerciseRow() {
  const row = document.createElement("div");
  row.className = "exercise-row";
  row.innerHTML = `
    <input class="exercise-id" placeholder="Exercise number or title" aria-label="Exercise number or title">
    <select class="exercise-outcome" aria-label="Exercise result">
      <option value="attempted">Attempted</option><option value="solved">Solved</option>
      <option value="partial">Partially solved</option><option value="incorrect">Incorrect</option>
      <option value="needs-review">Needs review</option>
    </select>
    <input class="exercise-description" placeholder="What did you work on?" aria-label="Exercise description">
    <button class="remove-exercise text-button" type="button">Remove</button>`;
  row.querySelector(".remove-exercise").addEventListener("click", () => row.remove());
  $("exerciseRows").append(row);
}

function openFinishDialog() {
  if (!appState.session) return;
  const isBook = appState.session.reference_kind === "book";
  $("endPositionLabel").classList.toggle("hidden", appState.session.mode === "assessment");
  $("endPositionLabel").firstChild.textContent = isBook ? "Ending PDF viewer page" : "Ending video time (MM:SS)";
  $("endPositionInput").value = appState.session.reference_kind === "book"
    ? String(appState.readerPage || appState.session.start_position || "")
    : appState.session.start_position || "";
  $("endPositionInput").placeholder = isBook ? "e.g. 48" : "e.g. 07:40";
  $("endPositionInput").required = appState.session.mode !== "assessment";
  $("scoreWrap").classList.toggle("hidden", appState.session.mode !== "assessment");
  $("gradeNotesWrap").classList.toggle("hidden", appState.session.mode !== "assessment");
  $("scoreInput").required = appState.session.mode === "assessment";
  $("conceptsInput").value = "";
  $("gradeNotesInput").value = "";
  $("exerciseRows").replaceChildren();
  addExerciseRow();
  openModal($("finishDialog"));
}

async function saveFinish(event) {
  event.preventDefault();
  if (!appState.session) return;
  const exercises = [...$("exerciseRows").querySelectorAll(".exercise-row")].map((row) => ({
    exercise_id: row.querySelector(".exercise-id").value,
    description: row.querySelector(".exercise-description").value,
    outcome: row.querySelector(".exercise-outcome").value,
  }));
  const payload = {
    end_position: $("endPositionInput").value,
    concepts: $("conceptsInput").value,
    exercises,
    score: $("scoreInput").value,
    grade_notes: $("gradeNotesInput").value,
  };
  await completeSession(payload);
}

async function completeSession(payload) {
  if (!appState.session) return;
  const isPdfLesson = appState.session.reference_kind === "book" && appState.session.mode !== "assessment";
  try {
    await api(`/api/session/${appState.session.id}/finish`, { method: "POST", body: JSON.stringify(payload) });
    $("finishDialog").close();
    appState.session = null;
    if (appState.heartbeatHandle) clearInterval(appState.heartbeatHandle);
    $("sessionView").classList.add("hidden");
    $("dashboardView").classList.remove("hidden");
    await loadDashboard();
    toast(isPdfLesson ? "PDF lesson finished and logged." : "Session saved. Your book/video cursor is ready for next time.");
  } catch (error) {
    toast(error.message);
  }
}

async function pauseOrResume() {
  if (!appState.session) return;
  const action = appState.session.status === "active" ? "pause" : "resume";
  try {
    const result = await api(`/api/session/${appState.session.id}/${action}`, { method: "POST", body: "{}" });
    appState.session = result.session;
    appState.timerBase = result.session.elapsed_seconds;
    appState.timerBaseMs = Date.now();
    $("pauseButton").textContent = action === "pause" ? "Resume" : "Pause";
    $("coachStatus").textContent = action === "pause" ? "Session paused" : "Here with you";
    renderTimer();
  } catch (error) {
    toast(error.message);
  }
}

async function connectChatGPT() {
  const button = $("authButton");
  button.disabled = true;
  try {
    const result = await api("/api/auth/login", { method: "POST", body: "{}" });
    if (!result.auth_url) throw new Error("Codex did not return a sign-in URL.");
    window.open(result.auth_url, "_blank", "noopener");
    toast("Complete ChatGPT sign-in in the new tab; this dashboard will check again shortly.");
    const started = Date.now();
    const poll = setInterval(async () => {
      const connected = await loadAuth();
      if (connected || Date.now() - started > 120000) clearInterval(poll);
    }, 2500);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

function showDashboard() {
  $("appShell").classList.remove("session-expanded");
  $("sessionView").classList.add("hidden");
  $("dashboardView").classList.remove("hidden");
  $("openDashboard").classList.add("hidden");
  loadDashboard().catch((error) => toast(error.message));
}

function wireEvents() {
  $("pdfFrame").addEventListener("load", () => bindPdfViewer("pdfFrame"));
  $("previewPdfFrame").addEventListener("load", () => bindPdfViewer("previewPdfFrame"));
  $("readPageWithCoach").addEventListener("change", (event) => {
    if (event.currentTarget.checked) markCurrentPageRead();
  });
  $("topicSelect").addEventListener("change", () => { populateReferences(); syncModeFields(); });
  $("referenceSelect").addEventListener("change", () => { populateReferences($("referenceSelect").value); syncModeFields(); });
  $("durationSelect").addEventListener("change", syncModeFields);
  $("modeSelect").addEventListener("change", syncModeFields);
  $("dismissTargetAlert").addEventListener("click", () => {
    appState.targetAlertDismissed = true;
    $("targetAlert").classList.add("hidden");
    $("timerCard").classList.remove("target-reached");
  });
  $("customDuration").addEventListener("input", () => {
    $("customDurationWrap").classList.toggle("hidden", $("durationSelect").value !== "custom");
  });
  $("setupForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const reference = currentReference();
    const mode = $("modeSelect").value;
    if (mode === "assessment") {
      prepareTargetSound();
      beginSession(mode, "").catch((error) => toast(error.message));
      return;
    }
    if (!reference.available) {
      toast("This reference file is unavailable. Check its OneDrive link.");
      return;
    }
    $("setupDialog").close();
    showPositioning(reference);
  });
  $("cancelSetup").addEventListener("click", () => $("setupDialog").close());
  $("cancelPosition").addEventListener("click", () => {
    $("positionDialog").close();
  });
  $("continueOpenSession").addEventListener("click", () => {
    continueSession().catch((error) => toast(error.message));
  });
  $("positionForm").addEventListener("submit", (event) => {
    event.preventDefault();
    if ($("beginButton").disabled) return;
    const position = $("startPositionInput").value.trim();
    if (appState.reference.kind === "book" && (!/^\d+$/.test(position) || Number(position) < 1)) {
      toast("Enter a positive PDF viewer page number.");
      return;
    }
    if (appState.reference.kind === "video" && !/^\d{1,4}:\d{2}$/.test(position)) {
      toast("Use a video time in MM:SS format.");
      return;
    }
    const button = $("beginButton");
    button.disabled = true;
    button.textContent = "Starting…";
    prepareTargetSound();
    beginSession("lesson", position).catch((error) => {
      if (error.message.includes("Connect ChatGPT")) connectChatGPT();
      if (!error.message.includes("current session")) toast(error.message);
    }).finally(() => {
      if ($("positionDialog").open) {
        button.disabled = false;
        button.textContent = "Begin lesson →";
      }
    });
  });
  $("startPositionInput").addEventListener("change", () => {
    if (appState.reference?.kind === "book" && $("startPositionInput").value) {
      setPdfPage(appState.reference, $("startPositionInput").value, "previewPdfFrame");
    }
  });
  $("toggleStudyPanel").addEventListener("click", () => {
    const collapsed = $("studyWorkspace").classList.toggle("panel-hidden");
    $("toggleStudyPanel").textContent = collapsed ? "Show study panel" : "Hide study panel";
    $("toggleStudyPanel").setAttribute("aria-expanded", String(!collapsed));
  });
  $("openVideoReference").addEventListener("click", () => {
    if (appState.reference) openReferenceTab(appState.reference);
  });
  $("finishButton").addEventListener("click", () => {
    if (appState.session?.reference_kind === "book" && appState.session.mode !== "assessment") {
      completeSession({ end_position: "", concepts: "", exercises: [] });
    } else {
      openFinishDialog();
    }
  });
  $("cancelFinish").addEventListener("click", () => $("finishDialog").close());
  $("finishForm").addEventListener("submit", saveFinish);
  $("addExercise").addEventListener("click", addExerciseRow);
  $("pauseButton").addEventListener("click", pauseOrResume);
  $("chatForm").addEventListener("submit", (event) => {
    event.preventDefault();
    if ($("sendButton").disabled) return;
    const text = $("chatInput").value.trim();
    if (!text || !appState.session) return;
    $("chatInput").value = "";
    streamChat(appState.session.id, text);
  });
  $("chatInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      $("chatForm").requestSubmit();
    }
  });
  $("backToDashboard").addEventListener("click", showDashboard);
  $("openDashboard").addEventListener("click", showDashboard);
  $("refreshButton").addEventListener("click", () => loadDashboard().catch((error) => toast(error.message)));
  $("openRecords").addEventListener("click", () => openStudyRecords());
  $("closeRecords").addEventListener("click", () => $("recordsDialog").close());
  $("clearRecordsButton").addEventListener("click", () => {
    $("clearRecordsStatus").textContent = "";
    $("confirmClearRecords").disabled = false;
    openModal($("clearRecordsDialog"));
    $("confirmClearRecords").focus();
  });
  $("cancelClearRecords").addEventListener("click", () => $("clearRecordsDialog").close());
  $("clearRecordsForm").addEventListener("submit", clearStudyRecords);
  $("recordsDialog").querySelectorAll(".record-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      appState.recordsKind = tab.dataset.recordKind;
      appState.recordsPage = 1;
      appState.selectedRecordKey = null;
      $("recordsDialog").querySelectorAll(".record-tab").forEach((item) => {
        const selected = item === tab;
        item.classList.toggle("selected", selected);
        item.setAttribute("aria-selected", String(selected));
      });
      renderRecordList(true);
    });
  });
  ["recordTopicFilter", "recordDateFrom", "recordDateTo"].forEach((id) => {
    $(id).addEventListener("change", () => {
      appState.recordsPage = 1;
      appState.selectedRecordKey = null;
      renderRecordList(true);
    });
  });
  $("recordsPrevPage").addEventListener("click", () => {
    if (appState.recordsPage <= 1) return;
    appState.recordsPage -= 1;
    appState.selectedRecordKey = null;
    renderRecordList(true);
  });
  $("recordsNextPage").addEventListener("click", () => {
    let filtered = appState.records.filter((record) => record.kind === appState.recordsKind);
    if (appState.recordsKind !== "weekly") {
      const topic = $("recordTopicFilter").value;
      const from = $("recordDateFrom").value;
      const to = $("recordDateTo").value;
      filtered = filtered.filter((record) =>
        (!topic || record.topic === topic)
        && (!from || (record.date && record.date >= from))
        && (!to || (record.date && record.date <= to))
      );
    }
    const total = filtered.length;
    const pageCount = Math.max(1, Math.ceil(total / appState.recordsPageSize));
    if (appState.recordsPage >= pageCount) return;
    appState.recordsPage += 1;
    appState.selectedRecordKey = null;
    renderRecordList(true);
  });
  $("authButton").addEventListener("click", connectChatGPT);
}

async function main() {
  wireEvents();
  renderLocalClock();
  appState.localClockHandle = setInterval(renderLocalClock, 1000);
  try {
    await loadConfig();
  } catch (error) {
    toast(`Could not load study topics: ${error.message}`);
    return;
  }
  syncModeFields();

  const [dashboardResult] = await Promise.allSettled([loadDashboard(), loadAuth()]);
  if (dashboardResult.status === "rejected") {
    toast(`Could not load study progress: ${dashboardResult.reason.message}`);
  }
  try {
    await restoreOpenSession();
  } catch (error) {
    toast(`Could not restore the open session: ${error.message}`);
  }
}

main();
