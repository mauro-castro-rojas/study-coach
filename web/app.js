import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";

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
  pdfViewerApps: {},
  pageReads: [],
  pageRangesDraft: [],
  pageRangesDraftSessionId: null,
  summaryEditorMode: "edit",
  summaryEditorView: null,
  pageSummaryOriginal: "",
  pageSummaryEditingPage: null,
  pageReadPending: false,
  manualMode: false,
  toastHandle: null,
  targetAlertSessionId: null,
  targetAlertDismissed: false,
  targetAlertToastShown: false,
  targetSoundPlayedForSession: null,
  audioContext: null,
  coachModels: [],
  coachModel: "",
  coachEffort: "",
  coachModelsLoading: false,
  coachModelsLoaded: false,
  records: [],
  recordsKind: "sessions",
  recordsPage: 1,
  recordsPageSize: 8,
  selectedRecordKey: null,
};

const $ = (id) => document.getElementById(id);
const COACH_PREFERENCES_KEY = "study-room-coach-preferences";
const api = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
};

function formatTokenCount(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat().format(Number(value));
}

function formatUsageWindow(minutes, fallback) {
  if (!Number.isFinite(Number(minutes)) || Number(minutes) <= 0) {
    return fallback === "primary" ? "Primary window" : "Secondary window";
  }
  const duration = Number(minutes);
  if (duration % 1440 === 0) return `${duration / 1440}-day window`;
  if (duration % 60 === 0) return `${duration / 60}-hour window`;
  return `${duration}-minute window`;
}

function usageElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function renderCodexUsage(data) {
  const content = $("codexUsageContent");
  content.replaceChildren();

  const plan = data.plan ? `Signed in with ChatGPT · ${data.plan}` : "Signed in with ChatGPT";
  content.append(usageElement("p", "usage-account", plan));

  const limitsHeading = usageElement("h3", "usage-section-title", "Usage limits");
  content.append(limitsHeading);
  if (!data.rate_limits?.length) {
    content.append(usageElement("p", "usage-muted", "Codex did not return any active usage windows."));
  } else {
    const limits = usageElement("div", "usage-limit-list");
    data.rate_limits.forEach((window) => {
      const card = usageElement("article", "usage-limit-card");
      const heading = usageElement("div", "usage-limit-heading");
      heading.append(
        usageElement("strong", "", window.limit_name),
        usageElement("span", "", formatUsageWindow(window.window_duration_mins, window.window_name)),
      );
      card.append(heading);

      if (window.used_percent !== null && window.used_percent !== undefined && Number.isFinite(Number(window.used_percent))) {
        const used = Math.min(100, Math.max(0, Number(window.used_percent)));
        const progress = usageElement("progress", "usage-progress");
        progress.max = 100;
        progress.value = used;
        progress.setAttribute("aria-label", `${window.limit_name} ${window.window_name} usage`);
        card.append(progress);
        card.append(usageElement("p", "usage-limit-detail", `${Math.round(100 - used)}% remaining · ${Math.round(used)}% used`));
      } else {
        card.append(usageElement("p", "usage-limit-detail", "Usage percentage not provided."));
      }

      if (Number.isFinite(Number(window.resets_at)) && Number(window.resets_at) > 0) {
        const reset = new Date(Number(window.resets_at) * 1000);
        card.append(usageElement("p", "usage-reset", `Resets ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(reset)}`));
      }
      limits.append(card);
    });
    content.append(limits);
  }

  content.append(usageElement("h3", "usage-section-title", "This Study Coach conversation"));
  const groups = data.thread_usage?.groups || [];
  const tokenGroups = groups.filter((group) => group.total_tokens !== null && group.total_tokens !== undefined);
  if (!tokenGroups.length) {
    const note = data.usage_error || "Token totals are not available for this conversation yet.";
    content.append(usageElement("p", "usage-muted", note));
  } else {
    const totalTokens = tokenGroups.reduce((total, group) => total + (Number(group.total_tokens) || 0), 0);
    content.append(usageElement("p", "usage-token-total", `${formatTokenCount(totalTokens)} tokens`));
    content.append(usageElement("p", "usage-muted", "Total tokens attributed to the current Study Coach conversation."));
    const breakdown = usageElement("ul", "usage-model-list");
    tokenGroups.forEach((group) => {
      const model = group.model || "Model not reported";
      const effort = group.reasoning_effort ? ` · ${group.reasoning_effort} effort` : "";
      const item = usageElement("li", "", `${model}${effort}: ${formatTokenCount(group.total_tokens)} tokens`);
      breakdown.append(item);
    });
    content.append(breakdown);
  }

  const updated = new Date(Number(data.updated_at) * 1000);
  $("codexUsageUpdated").textContent = `Updated ${new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(updated)}`;
}

async function loadCodexUsage() {
  const refresh = $("refreshCodexUsage");
  const content = $("codexUsageContent");
  refresh.disabled = true;
  refresh.textContent = "Loading…";
  content.replaceChildren(usageElement("p", "usage-muted", "Loading usage from Codex…"));
  try {
    renderCodexUsage(await api("/api/codex/usage"));
  } catch (error) {
    content.replaceChildren(usageElement("p", "usage-error", error.message));
    $("codexUsageUpdated").textContent = "";
  } finally {
    refresh.disabled = false;
    refresh.textContent = "Refresh";
  }
}

function readCoachPreferences() {
  try {
    return JSON.parse(localStorage.getItem(COACH_PREFERENCES_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveCoachPreferences() {
  try {
    localStorage.setItem(COACH_PREFERENCES_KEY, JSON.stringify({
      model: appState.coachModel,
      effort: appState.coachEffort,
    }));
  } catch {
    // The current choices still apply for this page even if browser storage is unavailable.
  }
}

function populateCoachEfforts(model, preferredEffort = "") {
  const select = $("coachEffortSelect");
  const efforts = model.efforts || [];
  select.replaceChildren(...efforts.map((effort) => {
    const option = new Option(effort.value, effort.value);
    option.title = effort.description || effort.value;
    return option;
  }));
  const validValues = efforts.map((effort) => effort.value);
  appState.coachEffort = validValues.includes(preferredEffort)
    ? preferredEffort
    : validValues.includes(model.default_effort) ? model.default_effort : (validValues[0] || "");
  select.value = appState.coachEffort;
  select.disabled = !appState.coachEffort;
}

async function loadCoachModels() {
  if (appState.coachModelsLoaded || appState.coachModelsLoading) return;
  appState.coachModelsLoading = true;
  const hint = $("coachSettingsHint");
  hint.textContent = "Loading models available to your ChatGPT account…";
  try {
    const data = await api("/api/codex/models");
    appState.coachModels = data.models || [];
    if (!appState.coachModels.length) throw new Error("No models supporting chat and PDF pages are available.");
    const saved = readCoachPreferences();
    const selected = appState.coachModels.find((model) => model.model === saved.model)
      || appState.coachModels.find((model) => model.is_default)
      || appState.coachModels[0];
    appState.coachModel = selected.model;
    const modelSelect = $("coachModelSelect");
    modelSelect.replaceChildren(...appState.coachModels.map((model) => {
      const option = new Option(model.display_name, model.model);
      option.title = model.description || model.display_name;
      return option;
    }));
    modelSelect.value = appState.coachModel;
    modelSelect.disabled = false;
    const preferredEffort = saved.model === appState.coachModel ? saved.effort : "";
    populateCoachEfforts(selected, preferredEffort);
    hint.textContent = "Changes apply to your next Coach reply and PDF page read.";
    appState.coachModelsLoaded = true;
    saveCoachPreferences();
  } catch (error) {
    hint.textContent = `Could not load Coach models: ${error.message}`;
  } finally {
    appState.coachModelsLoading = false;
  }
}

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

async function bindPdfViewer(viewerId) {
  const element = $(viewerId);
  try {
    await customElements.whenDefined("pdfjs-viewer-element");
    const { viewerApp } = await element.initPromise;
    appState.pdfViewerApps[viewerId] = viewerApp;
    if (element.dataset.studyRoomBound === "true") return;
    element.dataset.studyRoomBound = "true";
    const syncPage = ({ pageNumber } = {}) => {
      const page = Number(pageNumber || viewerApp.pdfViewer.currentPageNumber || 1);
      if (viewerId === "pdfFrame") {
        appState.readerPage = page;
        updatePageReadControl();
      } else if (viewerId === "previewPdfFrame") {
        $("startPositionInput").value = String(page);
      }
    };
    viewerApp.eventBus.on("pagechanging", syncPage);
    viewerApp.eventBus.on("pagesloaded", syncPage);
    syncPage();
  } catch (error) {
    console.warn("Could not connect the PDF viewer to Study Room", error);
  }
}

function updatePageReadControl() {
  const control = $("readPageWithCoach");
  if (!control) return;
  const page = Number(appState.readerPage);
  const recorded = appState.pageReads.some((item) => Number(item.pdf_page) === page);
  const loaded = Boolean(appState.pdfViewerApps.pdfFrame?.pdfDocument);
  control.checked = recorded;
  const manualMode = appState.session?.coach_mode === "manual";
  control.disabled = appState.pageReadPending || !loaded || !page || recorded || (!manualMode && $("sendButton").disabled);
  $("pageReadLabel").textContent = recorded ? "Page read" : "Mark as read";
  renderPageReadTracker();
  const requiresPage = appState.session?.reference_kind === "book" && appState.session?.mode !== "assessment";
  const needsReadPage = requiresPage && appState.pageReads.length === 0;
  $("finishButton").disabled = Boolean(needsReadPage || appState.pageReadPending);
  $("pdfFinishHint").textContent = appState.pageReadPending
    ? "Wait for this page to finish saving before ending the session."
    : "Mark at least one PDF page as read to finish and log this lesson.";
  $("pdfFinishHint").classList.toggle("hidden", !needsReadPage && !appState.pageReadPending);
}

function renderPageReadTracker() {
  const pages = sortedPageReads();
  const tracker = $("pageReadTracker");
  if (!tracker) return;
  tracker.classList.toggle("hidden", pages.length === 0);
  $("pageReadTrackerCount").textContent = `${pages.length} ${pages.length === 1 ? "page" : "pages"}`;
  const list = $("pageReadTrackerList");
  list.replaceChildren(...pages.map((page) => {
    const item = document.createElement("li");
    item.textContent = `p. ${page.pdf_page}`;
    item.title = `PDF viewer page ${page.pdf_page} is marked as read`;
    return item;
  }));
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
  const viewer = $(frameId);
  viewer.setAttribute("assets-base", "/pdfjs/");
  viewer.setAttribute("src", reference.route.split("#", 1)[0]);
  viewer.setAttribute("page", String(requested));
  bindPdfViewer(frameId);
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

function syncDashboardStudyMode() {
  $("manualModeToggle").checked = appState.manualMode;
}

function setDashboardStudyMode(manualMode) {
  appState.manualMode = Boolean(manualMode);
  try {
    localStorage.setItem("study-room-manual-mode", String(appState.manualMode));
  } catch {
    // The current choice still applies until this page is closed.
  }
  syncDashboardStudyMode();
}

function restoreDashboardStudyMode() {
  try {
    appState.manualMode = localStorage.getItem("study-room-manual-mode") === "true";
  } catch {
    appState.manualMode = false;
  }
  syncDashboardStudyMode();
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
      loadCoachModels();
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
  let source = String(text);
  const inlineTokens = [];
  const preserve = (html) => {
    inlineTokens.push(html);
    return `%%INLINETOKEN${inlineTokens.length - 1}%%`;
  };
  source = source.replace(/`([^`\n]+)`/g, (_match, code) => preserve(`<code>${escapeHtml(code)}</code>`));
  source = source.replace(/\\\(([\s\S]+?)\\\)/g, (_match, formula) => (
    preserve(renderMath(formula, false))
  ));
  source = source.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt, path) => {
    const attachment = path.match(/^\.\.\/attachments\/([a-f0-9]{32})\/([a-f0-9]{32})\.png$/);
    if (!attachment) return match;
    return preserve(
      `<img class="study-note-image" src="/records/attachments/${attachment[1]}/${attachment[2]}.png" alt="${escapeHtml(alt)}" loading="lazy">`,
    );
  });
  let html = escapeHtml(source);
  html = html
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  return html.replace(/%%INLINETOKEN(\d+)%%/g, (_match, index) => inlineTokens[Number(index)]);
}

function renderMath(formula, displayMode) {
  if (!window.katex) return escapeHtml(formula);
  try {
    return window.katex.renderToString(formula, {
      displayMode,
      throwOnError: false,
      trust: false,
    });
  } catch {
    return `<code class="math-fallback">${escapeHtml(formula)}</code>`;
  }
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
    const singleLineMath = line.match(/^\s*\\\[([\s\S]*?)\\\]\s*$/);
    if (singleLineMath) {
      flushParagraph();
      flushList();
      output.push(`<div class="math-display">${renderMath(singleLineMath[1].trim(), true)}</div>`);
      continue;
    }
    if (/^\s*\\\[\s*$/.test(line)) {
      flushParagraph();
      flushList();
      const formulaLines = [];
      let closingLine = lineIndex + 1;
      while (closingLine < lines.length && !/^\s*\\\]\s*$/.test(lines[closingLine])) {
        formulaLines.push(lines[closingLine]);
        closingLine += 1;
      }
      if (closingLine < lines.length) {
        output.push(`<div class="math-display">${renderMath(formulaLines.join("\n").trim(), true)}</div>`);
        lineIndex = closingLine;
        continue;
      }
      paragraph.push(line);
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
            const pageRange = (data.page_ranges || []).find((item) => (
              Number(item.start_page) <= Number(page.pdf_page)
              && Number(page.pdf_page) <= Number(item.end_page)
            ));
            heading.textContent = pageRange
              ? `Chapter ${pageRange.chapter} · Section ${pageRange.section} · p. ${page.pdf_page}`
              : `p. ${page.pdf_page}`;
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
    if (result.export_errors || result.attachment_errors) {
      toast(`Database cleared, but ${result.export_errors} generated file(s) and ${result.attachment_errors} screenshot(s) could not be deleted.`);
    } else {
      toast(`Study records cleared. Removed ${result.sessions} session(s), ${result.images} screenshot(s), and ${result.exports} generated file(s).`);
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
      body: JSON.stringify({
        message: text,
        model: appState.coachModel,
        effort: appState.coachEffort,
        ...(imageDataUrl ? { image_data_url: imageDataUrl, page_number: pageNumber } : {}),
      }),
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
  const manualMode = appState.session.coach_mode === "manual";
  if ((!manualMode && $("sendButton").disabled) || appState.pageReadPending) return;
  const viewer = appState.pdfViewerApps.pdfFrame;
  const pageNumber = Number(viewer?.pdfViewer?.currentPageNumber || 0);
  if (!viewer?.pdfDocument || !Number.isInteger(pageNumber) || pageNumber < 1) {
    toast("The PDF page is still loading. Try again in a moment.");
    return;
  }
  const control = $("readPageWithCoach");
  if (appState.pageReads.some((item) => Number(item.pdf_page) === pageNumber)) return;
  appState.pageReadPending = true;
  $("sendButton").disabled = true;
  $("chatInput").disabled = true;
  control.checked = false;
  updatePageReadControl();
  $("pageReadLabel").textContent = "Saving progress…";
  try {
    if (manualMode) {
      const result = await api(`/api/session/${appState.session.id}/mark-page`, {
        method: "POST",
        body: JSON.stringify({ page_number: pageNumber }),
      });
      const markedPage = result.page;
      appState.pageReads.push(markedPage);
      appState.session.page_reads = appState.pageReads;
      updatePageReadControl();
      toast(`p. ${markedPage.pdf_page} marked as read.`);
      openPageSummaryWorkspace(markedPage.pdf_page);
      return;
    }
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
      body: JSON.stringify({
        page_number: pageNumber,
        page_text: pageText,
        image_data_url: imageDataUrl,
        model: appState.coachModel,
        effort: appState.coachEffort,
      }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Could not save this page (${response.status}).`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let recorded = false;
    let newlyRecordedPage = null;
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
          newlyRecordedPage = Number(data.pdf_page);
          appState.pageReads.push({
            pdf_page: data.pdf_page,
            printed_page: data.printed_page,
            summary: data.summary,
            concepts: data.concepts || [],
          });
          appState.session.page_reads = appState.pageReads;
          if (data.exercise_message) appendMessage("assistant", data.exercise_message);
          updatePageReadControl();
          toast(`PDF viewer page ${data.pdf_page} saved to this session.`);
        }
      }
    }
    if (!recorded) throw new Error("Could not save this page. Please try again.");
    if (newlyRecordedPage) openPageSummaryWorkspace(newlyRecordedPage);
  } catch (error) {
    control.checked = false;
    toast(error.message);
  } finally {
    appState.pageReadPending = false;
    const stillManual = appState.session?.coach_mode === "manual";
    $("sendButton").disabled = stillManual;
    $("chatInput").disabled = stillManual;
    updatePageReadControl();
  }
}

function showSession(session, messages = []) {
  appState.session = session;
  const manualMode = session.coach_mode === "manual";
  appState.pageReads = session.page_reads || [];
  renderPageReadTracker();
  appState.pageReadPending = false;
  if (appState.targetAlertSessionId !== session.id) {
    appState.targetAlertSessionId = session.id;
    appState.targetAlertDismissed = false;
    appState.targetAlertToastShown = false;
    appState.targetSoundPlayedForSession = null;
  }
  $("timerCard").classList.remove("target-reached");
  $("targetAlert").classList.add("hidden");
  $("pageSummaryWorkspace").classList.add("hidden");
  $("appShell").classList.add("session-expanded");
  $("studyWorkspace").classList.remove("summary-editing");
  $("appShell").classList.toggle("manual-session", manualMode);
  appState.reference = appState.config.topics
    .find((topic) => topic.id === session.topic_id)?.references
    .find((reference) => reference.id === session.reference_id) || null;
  $("dashboardView").classList.add("hidden");
  $("sessionView").classList.remove("hidden");
  $("openDashboard").classList.remove("hidden");
  $("sessionTopicLabel").textContent = session.topic_title.toUpperCase();
  $("sessionTitle").textContent = session.topic_title;
  $("sessionReference").textContent = session.reference_title;
  $("sessionModeBadge").textContent = manualMode
    ? (session.mode === "assessment" ? "MANUAL PRACTICE TEST" : "MANUAL STUDY")
    : (session.mode === "assessment" ? "PRACTICE TEST" : "GUIDED STUDY");
  const hasPdf = session.reference_kind === "book" && session.mode !== "assessment";
  const needsReadPage = hasPdf && appState.pageReads.length === 0;
  const hasVideo = session.reference_kind === "video" && session.mode !== "assessment";
  $("pdfReader").classList.toggle("hidden", !hasPdf);
  $("pageReadControl").classList.toggle("hidden", !hasPdf);
  $("readPageWithCoach").disabled = true;
  $("pdfFinishHint").classList.toggle("hidden", !needsReadPage);
  $("finishButton").disabled = needsReadPage;
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
  $("chatInput").disabled = manualMode;
  $("sendButton").disabled = manualMode;
  $("openCodexUsage").classList.toggle("hidden", manualMode);
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
      if (appState.session?.status !== "active") return;
      appState.session = data.session;
      appState.timerBase = data.session.elapsed_seconds;
      appState.timerBaseMs = Date.now();
    } catch (error) {
      console.warn("Study timer heartbeat failed", error);
    }
  }, 12000);
}

function syncTimer(session) {
  if (appState.timer) clearInterval(appState.timer);
  appState.timer = null;
  appState.timerBase = Number(session.elapsed_seconds || 0);
  appState.timerBaseMs = Date.now();
  renderTimer();
  if (session.status === "active") {
    appState.timer = setInterval(renderTimer, 250);
  }
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
    coach_mode: appState.manualMode ? "manual" : "coach",
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
  if (mode === "assessment" && response.session.coach_mode !== "manual") await streamChat(response.session.id, "", true);
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

function sortedPageReads() {
  return [...appState.pageReads].sort((a, b) => Number(a.pdf_page) - Number(b.pdf_page));
}

function renderFinishReadPages() {
  const list = $("finishReadPageList");
  list.replaceChildren();
  for (const page of sortedPageReads()) {
    const item = document.createElement("li");
    item.textContent = `p. ${page.pdf_page}`;
    list.append(item);
  }
}

function saveChapterRangeDraft() {
  appState.pageRangesDraft = [...$("chapterRangeRows").querySelectorAll(".chapter-range-row")].map((row) => ({
    chapter: row.querySelector(".range-chapter").value.trim(),
    section: row.querySelector(".range-section").value.trim(),
    start_page: row.querySelector(".range-start-page").value,
    end_page: row.querySelector(".range-end-page").value,
  }));
}

function addChapterRangeRow(range = {}) {
  const row = document.createElement("fieldset");
  row.className = "chapter-range-row";
  row.innerHTML = `
    <legend class="visually-hidden">Chapter and section page range</legend>
    <div class="chapter-range-fields">
      <label>Chapter number or title<input class="range-chapter" maxlength="160" placeholder="e.g. 2 or File systems" value="${escapeHtml(range.chapter || "")}" required></label>
      <label>Section number or title<input class="range-section" maxlength="200" placeholder="e.g. 3 or Managing files" value="${escapeHtml(range.section || "")}" required></label>
      <label>From PDF page<input class="range-start-page" type="number" min="1" step="1" value="${escapeHtml(range.start_page ?? "")}" required></label>
      <label>To PDF page<input class="range-end-page" type="number" min="1" step="1" value="${escapeHtml(range.end_page ?? "")}" required></label>
    </div>
    <button class="remove-chapter-range text-button" type="button" aria-label="Remove chapter and section range">Remove range</button>`;
  row.addEventListener("input", saveChapterRangeDraft);
  row.querySelector(".remove-chapter-range").addEventListener("click", () => {
    if ($("chapterRangeRows").children.length <= 1) return;
    row.remove();
    saveChapterRangeDraft();
  });
  $("chapterRangeRows").append(row);
}

function initializeChapterRanges() {
  const rows = $("chapterRangeRows");
  rows.replaceChildren();
  const pages = sortedPageReads().map((page) => Number(page.pdf_page));
  const ranges = appState.pageRangesDraft.length
    ? appState.pageRangesDraft
    : appState.session.page_ranges?.length
      ? appState.session.page_ranges
      : pages.length ? [{ start_page: Math.min(...pages), end_page: Math.max(...pages) }] : [];
  for (const range of ranges) addChapterRangeRow(range);
  if (!ranges.length) addChapterRangeRow();
  saveChapterRangeDraft();
}

function validateChapterRanges() {
  const error = $("chapterRangeError");
  error.classList.add("hidden");
  const ranges = [...$("chapterRangeRows").querySelectorAll(".chapter-range-row")].map((row) => ({
    chapter: row.querySelector(".range-chapter").value.trim(),
    section: row.querySelector(".range-section").value.trim(),
    start_page: Number(row.querySelector(".range-start-page").value),
    end_page: Number(row.querySelector(".range-end-page").value),
  }));
  const fail = (message) => {
    error.textContent = message;
    error.classList.remove("hidden");
    return null;
  };
  if (ranges.some((range) => !range.chapter || !range.section)) {
    return fail("Enter a chapter and section for every range.");
  }
  if (ranges.some((range) => !Number.isInteger(range.start_page) || !Number.isInteger(range.end_page)
    || range.start_page < 1 || range.end_page < range.start_page)) {
    return fail("Enter a valid starting and ending PDF page for every range.");
  }
  ranges.sort((a, b) => a.start_page - b.start_page);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start_page <= ranges[index - 1].end_page) {
      return fail("Ranges cannot overlap. Adjust their PDF page boundaries.");
    }
  }
  for (const page of sortedPageReads()) {
    const matchingRanges = ranges.filter((range) => (
      range.start_page <= Number(page.pdf_page) && Number(page.pdf_page) <= range.end_page
    ));
    if (matchingRanges.length !== 1) {
      return fail(`Assign scanned PDF page ${page.pdf_page} to exactly one chapter and section range.`);
    }
  }
  saveChapterRangeDraft();
  return ranges;
}

function renderSelectedPageSummary() {
  const page = appState.pageReads.find((item) => Number(item.pdf_page) === Number($("summaryPageSelect").value));
  appState.pageSummaryEditingPage = page?.pdf_page ?? null;
  if (appState.summaryEditorView) {
    appState.summaryEditorView.dispatch({
      changes: {
        from: 0,
        to: appState.summaryEditorView.state.doc.length,
        insert: page?.summary || "",
      },
    });
  }
  appState.pageSummaryOriginal = page?.summary || "";
  $("pageSummarySaveStatus").textContent = "";
  $("pageSummarySaveStatus").classList.remove("summary-save-error");
  renderPageSummaryPreview();
}

function summaryEditorText() {
  return appState.summaryEditorView?.state.doc.toString() || "";
}

function renderPageSummaryPreview() {
  const page = appState.pageReads.find((item) => Number(item.pdf_page) === Number($("summaryPageSelect").value));
  const markdownText = summaryEditorText();
  if (page) page.summary = markdownText;
  $("pageSummaryPreview").innerHTML = renderMarkdown(markdownText);
}

function setSummaryEditorMode(mode) {
  appState.summaryEditorMode = mode;
  const isPreview = mode === "preview";
  $("pageSummaryEditor").classList.toggle("hidden", isPreview);
  $("pageSummaryPreview").classList.toggle("hidden", !isPreview);
  $("summaryEditTab").classList.toggle("selected", !isPreview);
  $("summaryPreviewTab").classList.toggle("selected", isPreview);
  $("summaryEditTab").setAttribute("aria-selected", String(!isPreview));
  $("summaryPreviewTab").setAttribute("aria-selected", String(isPreview));
  if (isPreview) {
    renderPageSummaryPreview();
  } else {
    requestAnimationFrame(() => appState.summaryEditorView?.requestMeasure());
    appState.summaryEditorView?.focus();
  }
}

function initializeSummaryEditor() {
  if (appState.summaryEditorView) return;
  const theme = EditorView.theme({
    "&": {
      height: "100%",
      fontSize: "12px",
    },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: '"DM Mono", monospace',
    },
    ".cm-content": {
      padding: "13px 14px",
    },
    ".cm-gutters": {
      borderRight: "1px solid #e3eae3",
      backgroundColor: "#f7f9f7",
      color: "#87948c",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "#eaf1eb",
    },
    ".cm-activeLine": {
      backgroundColor: "#f8faf8",
    },
  });
  appState.summaryEditorView = new EditorView({
    state: EditorState.create({
      doc: "",
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle),
        indentUnit.of("  "),
        EditorView.lineWrapping,
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.domEventHandlers({
          paste(event, view) {
            const hasImage = [...(event.clipboardData?.items || [])]
              .some((item) => item.type.startsWith("image/"));
            if (!hasImage) return false;
            pastePageSummaryImage(event, view);
            return true;
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) renderPageSummaryPreview();
        }),
        theme,
      ],
    }),
    parent: $("pageSummaryEditor"),
  });
}

function closePageSummaryWorkspace() {
  $("pageSummaryWorkspace").classList.add("hidden");
  $("studyWorkspace").classList.remove("summary-editing");
}

function openPageSummaryWorkspace(viewerPage) {
  if ($("finishDialog").open) $("finishDialog").close();
  const select = $("summaryPageSelect");
  select.replaceChildren(...sortedPageReads().map((page) => {
    const option = new Option(`p. ${page.pdf_page}`, String(page.pdf_page));
    return option;
  }));
  const index = [...select.options].findIndex((option) => Number(option.value) === Number(viewerPage));
  if (index >= 0) select.selectedIndex = index;
  initializeSummaryEditor();
  renderSelectedPageSummary();
  setSummaryEditorMode("edit");
  $("pageSummaryWorkspace").classList.remove("hidden");
  $("studyWorkspace").classList.add("summary-editing");
  requestAnimationFrame(() => {
    appState.summaryEditorView?.requestMeasure();
    appState.summaryEditorView?.focus();
  });
}

async function savePageSummary() {
  const page = appState.pageReads.find((item) => Number(item.pdf_page) === Number(appState.pageSummaryEditingPage));
  if (!page) return false;
  const summary = summaryEditorText().trim();
  if (!summary) {
    $("pageSummarySaveStatus").textContent = "Page notes cannot be empty.";
    $("pageSummarySaveStatus").classList.add("summary-save-error");
    return false;
  }
  const button = $("savePageSummary");
  button.disabled = true;
  button.textContent = "Saving…";
  $("pageSummarySaveStatus").textContent = "";
  $("pageSummarySaveStatus").classList.remove("summary-save-error");
  try {
    const result = await api(`/api/session/${appState.session.id}/page-summary`, {
      method: "POST",
      body: JSON.stringify({ pdf_page: Number(page.pdf_page), summary }),
    });
    page.summary = result.page.summary;
    page.images = result.page.images || [];
    appState.pageSummaryOriginal = page.summary;
    appState.summaryEditorView.dispatch({
      changes: {
        from: 0,
        to: appState.summaryEditorView.state.doc.length,
        insert: page.summary,
      },
    });
    renderPageSummaryPreview();
    return true;
  } catch (error) {
    $("pageSummarySaveStatus").textContent = `Could not save notes: ${error.message}`;
    $("pageSummarySaveStatus").classList.add("summary-save-error");
    return false;
  } finally {
    button.disabled = false;
    button.textContent = "Save notes";
  }
}

async function pastedImageAsPng(file) {
  if (file.type === "image/png") return file;
  if (typeof createImageBitmap !== "function") {
    throw new Error("This browser cannot convert the pasted image to PNG.");
  }
  const bitmap = await createImageBitmap(file);
  if (bitmap.width * bitmap.height > 40_000_000) {
    bitmap.close();
    throw new Error("The pasted image dimensions are too large.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not convert the pasted image to PNG."));
    }, "image/png");
  });
}

async function pastePageSummaryImage(event, view) {
  const imageItem = [...(event.clipboardData?.items || [])]
    .find((item) => item.type.startsWith("image/"));
  const file = imageItem?.getAsFile();
  if (!file) return;
  event.preventDefault();
  const selection = view.state.selection.main;
  const start = selection.from;
  const end = selection.to;
  const page = appState.pageReads.find((item) => Number(item.pdf_page) === Number(appState.pageSummaryEditingPage));
  if (!page || !appState.session) return;
  view.contentDOM.setAttribute("contenteditable", "false");
  $("pageSummarySaveStatus").textContent = "Adding screenshot…";
  $("pageSummarySaveStatus").classList.remove("summary-save-error");
  try {
    const png = await pastedImageAsPng(file);
    if (png.size > 20_000_000) throw new Error("The pasted PNG must be smaller than 20 MB.");
    const response = await fetch(`/api/session/${appState.session.id}/page-image?pdf_page=${page.pdf_page}`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: png,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Could not save the image (${response.status}).`);
    const imagePath = `../attachments/${appState.session.id}/${result.image.id}.png`;
    const editorText = view.state.doc.toString();
    const before = editorText.slice(0, start);
    const after = editorText.slice(end);
    const prefix = before && !before.endsWith("\n") ? "\n\n" : "";
    const suffix = after && !after.startsWith("\n") ? "\n\n" : "";
    const markdown = `![Screenshot for p. ${page.pdf_page}](${imagePath})`;
    const insertion = `${prefix}${markdown}${suffix}`;
    const cursor = before.length + insertion.length;
    view.dispatch({
      changes: { from: start, to: end, insert: insertion },
      selection: { anchor: cursor },
    });
    page.images ||= [];
    page.images.push(result.image);
    renderPageSummaryPreview();
    await savePageSummary();
  } catch (error) {
    $("pageSummarySaveStatus").textContent = `Could not add screenshot: ${error.message}`;
    $("pageSummarySaveStatus").classList.add("summary-save-error");
  } finally {
    view.contentDOM.setAttribute("contenteditable", "true");
    view.focus();
  }
}

function openFinishDialog() {
  if (!appState.session) return;
  const isPdfLesson = appState.session.reference_kind === "book" && appState.session.mode !== "assessment";
  const isBook = appState.session.reference_kind === "book";
  $("finishTitle").textContent = isPdfLesson ? "Review your reading record" : "What did you cover?";
  $("finishIntro").textContent = isPdfLesson
    ? "Confirm the pages the Coach scanned, assign their chapter and section, and review each summary before saving."
    : "A quick record now makes your next lesson—and your dashboard—more useful.";
  $("endPositionLabel").classList.toggle("hidden", appState.session.mode === "assessment" || isPdfLesson);
  $("endPositionLabel").firstChild.textContent = isBook ? "Ending PDF viewer page" : "Ending video time (MM:SS)";
  $("endPositionInput").value = appState.session.reference_kind === "book"
    ? String(appState.readerPage || appState.session.start_position || "")
    : appState.session.start_position || "";
  $("endPositionInput").placeholder = isBook ? "e.g. 48" : "e.g. 07:40";
  $("endPositionInput").required = appState.session.mode !== "assessment" && !isPdfLesson;
  $("scoreWrap").classList.toggle("hidden", appState.session.mode !== "assessment");
  $("gradeNotesWrap").classList.toggle("hidden", appState.session.mode !== "assessment");
  $("conceptsLabel").classList.toggle("hidden", isPdfLesson);
  $("exerciseHeading").classList.toggle("hidden", isPdfLesson);
  $("exerciseRows").classList.toggle("hidden", isPdfLesson);
  $("pdfFinishSection").classList.toggle("hidden", !isPdfLesson);
  $("scoreInput").required = appState.session.mode === "assessment";
  $("conceptsInput").value = "";
  $("gradeNotesInput").value = "";
  if (isPdfLesson) {
    if (appState.pageRangesDraftSessionId !== appState.session.id) {
      appState.pageRangesDraft = [];
      appState.pageRangesDraftSessionId = appState.session.id;
    }
    renderFinishReadPages();
    initializeChapterRanges();
  }
  $("exerciseRows").replaceChildren();
  if (!isPdfLesson) addExerciseRow();
  openModal($("finishDialog"));
}

async function saveFinish(event) {
  event.preventDefault();
  if (!appState.session) return;
  const isPdfLesson = appState.session.reference_kind === "book" && appState.session.mode !== "assessment";
  const pageRanges = isPdfLesson ? validateChapterRanges() : [];
  if (isPdfLesson && !pageRanges) return;
  const pageSummaries = isPdfLesson ? sortedPageReads().map((page) => ({
    pdf_page: Number(page.pdf_page),
    summary: page.summary,
  })) : [];
  if (isPdfLesson && pageSummaries.some((item) => !item.summary?.trim())) {
    $("chapterRangeError").textContent = "Every scanned PDF page needs a non-empty summary.";
    $("chapterRangeError").classList.remove("hidden");
    setSummaryEditorMode("edit");
    return;
  }
  const exercises = isPdfLesson ? [] : [...$("exerciseRows").querySelectorAll(".exercise-row")].map((row) => ({
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
    ...(isPdfLesson ? { page_ranges: pageRanges, page_summaries: pageSummaries } : {}),
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
    if (appState.timer) clearInterval(appState.timer);
    appState.timer = null;
    $("sessionView").classList.add("hidden");
    $("dashboardView").classList.remove("hidden");
    await loadDashboard();
    appState.pageRangesDraft = [];
    appState.pageRangesDraftSessionId = null;
    toast(isPdfLesson ? "PDF lesson finished and logged." : "Session saved. Your book/video cursor is ready for next time.");
  } catch (error) {
    toast(error.message);
  }
}

async function pauseOrResume() {
  if (!appState.session) return;
  const action = appState.session.status === "active" ? "pause" : "resume";
  const button = $("pauseButton");
  button.disabled = true;
  button.textContent = action === "pause" ? "Pausing…" : "Resuming…";
  try {
    const result = await api(`/api/session/${appState.session.id}/${action}`, { method: "POST", body: "{}" });
    appState.session = result.session;
    syncTimer(result.session);
    button.textContent = action === "pause" ? "Resume" : "Pause";
    $("coachStatus").textContent = action === "pause" ? "Session paused" : "Here with you";
  } catch (error) {
    button.textContent = appState.session.status === "active" ? "Pause" : "Resume";
    toast(error.message);
  } finally {
    button.disabled = false;
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
  $("manualModeToggle").addEventListener("change", (event) => {
    setDashboardStudyMode(event.currentTarget.checked);
  });
  $("addChapterRange").addEventListener("click", () => {
    addChapterRangeRow();
    saveChapterRangeDraft();
  });
  $("summaryPageSelect").addEventListener("change", async () => {
    const nextPage = Number($("summaryPageSelect").value);
    if (summaryEditorText().trim() !== appState.pageSummaryOriginal.trim() && !(await savePageSummary())) {
      $("summaryPageSelect").value = String(appState.pageSummaryEditingPage);
      return;
    }
    renderSelectedPageSummary();
    if (!Number.isNaN(nextPage)) $("summaryPageSelect").value = String(nextPage);
  });
  $("savePageSummary").addEventListener("click", async () => {
    if (await savePageSummary()) closePageSummaryWorkspace();
  });
  $("reviewSummariesButton").addEventListener("click", () => {
    const firstPage = sortedPageReads()[0];
    if (firstPage) openPageSummaryWorkspace(firstPage.pdf_page);
  });
  $("closePageSummary").addEventListener("click", async () => {
    const saved = summaryEditorText().trim() === appState.pageSummaryOriginal.trim() || await savePageSummary();
    if (saved) closePageSummaryWorkspace();
  });
  $("summaryEditTab").addEventListener("click", () => setSummaryEditorMode("edit"));
  $("summaryPreviewTab").addEventListener("click", () => setSummaryEditorMode("preview"));
  $("openCodexUsage").addEventListener("click", () => {
    $("codexUsageDialog").showModal();
    loadCodexUsage();
  });
  $("closeCodexUsage").addEventListener("click", () => $("codexUsageDialog").close());
  $("refreshCodexUsage").addEventListener("click", loadCodexUsage);
  $("readPageWithCoach").addEventListener("change", (event) => {
    if (event.currentTarget.checked) markCurrentPageRead();
  });
  $("coachModelSelect").addEventListener("change", () => {
    const model = appState.coachModels.find((item) => item.model === $("coachModelSelect").value);
    if (!model) return;
    appState.coachModel = model.model;
    populateCoachEfforts(model);
    saveCoachPreferences();
  });
  $("coachEffortSelect").addEventListener("change", () => {
    appState.coachEffort = $("coachEffortSelect").value;
    saveCoachPreferences();
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
    openFinishDialog();
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
  restoreDashboardStudyMode();
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
