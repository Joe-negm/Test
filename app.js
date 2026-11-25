// ============================================================================
// Cambridge Math Arena — full frontend
// Features: AI hints, DMs, owner hint log, teacher overview,
// weekly certificates, exports, 1v1 challenges (all-platform, presence),
// profile avatars.
// ============================================================================

const DEFAULT_SUPABASE_URL = "https://yktszhisgtrzggorhzwo.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlrdHN6aGlzZ3Ryemdnb3JoendvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ4MjYzOTAsImV4cCI6MjExMDQwMjM5MH0.jKaihUD8OoFyQe7hEF8VPytPQg6PfZx0ir6rNJqEwbE";
const STUDENT_EMAIL_DOMAIN = "student.cambridgemath.local";

let supabaseClient = null;
let studentSignupClient = null;
let currentUser = null;
let currentProfile = null;

let allTopics = [];
let allQuestions = [];
let mySolvedQuestionIds = new Set();
let pendingAnswerGroups = [];
let activeTopicId = null;
let teacherStudentsCache = [];
let globalStudentsCache = [];
let activeConversationId = null;
let unreadPollTimer = null;
let certCache = [];
let certificatesRefreshTimer = null;

// Avatar state
let pendingAvatarFile = null;
let pendingAvatarRemoved = false;

// ----------------------------------------------------------------------------
function getSupabaseConfig() {
  const url = DEFAULT_SUPABASE_URL || localStorage.getItem("cm_supabase_url") || "";
  const key = DEFAULT_SUPABASE_ANON_KEY || localStorage.getItem("cm_supabase_key") || "";
  return { url: url.trim(), key: key.trim() };
}
function initSupabase() {
  const { url, key } = getSupabaseConfig();
  const banner = document.getElementById("config-banner");
  if (!url || !key) { banner.classList.remove("hidden"); return false; }
  banner.classList.add("hidden");
  const { createClient } = window.supabase;
  supabaseClient = createClient(url, key);
  studentSignupClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return true;
}

document.addEventListener("DOMContentLoaded", async () => {
  bindStaticEvents();
  if (initSupabase()) await checkSessionAndBoot();
});

// ----------------------------------------------------------------------------
function showToast(message, type = "info") {
  const c = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  c.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function usernameToEmail(u) {
  const clean = u.trim().toLowerCase().replace(/[^a-z0-9_.]/g, "");
  return { clean, email: `${clean}@${STUDENT_EMAIL_DOMAIN}` };
}
function isTeacherSubscriptionActive(p) {
  if (!p) return false;
  if (p.subscription_waived) return true;
  if (!p.trial_ends_at) return false;
  return new Date(p.trial_ends_at) > new Date();
}
function daysLeftInTrial(t) {
  if (!t) return 0;
  return Math.max(0, Math.ceil((new Date(t) - new Date()) / 86400000));
}
function formatRankMedal(r) {
  if (r === 1) return "🥇 #1";
  if (r === 2) return "🥈 #2";
  if (r === 3) return "🥉 #3";
  return `#${r}`;
}
function fmtDate(iso) {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ----------------------------------------------------------------------------
// Avatar rendering
// ----------------------------------------------------------------------------
function renderAvatarHtml(profile, size = 40, options = {}) {
  const { showOnlineDot = false, isOnline = false } = options;
  const name = profile?.full_name || "?";
  const initials = name.split(" ").map(p => p[0]).filter(Boolean).join("").slice(0, 2).toUpperCase() || "?";
  const url = profile?.avatar_url;
  const inner = url
    ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" />`
    : `<span class="avatar-initials">${escapeHtml(initials)}</span>`;
  const dot = showOnlineDot
    ? (isOnline
        ? `<span class="online-dot" title="Online"></span>`
        : `<span class="offline-dot" title="Offline"></span>`)
    : "";
  const fs = Math.max(11, Math.round(size * 0.4));
  return `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${fs}px;">${inner}${dot}</span>`;
}

function refreshHeaderAvatar() {
  const el = document.getElementById("header-avatar");
  if (el) el.innerHTML = renderAvatarHtml(currentProfile, 34);
}

function openAvatarModal() {
  pendingAvatarFile = null;
  pendingAvatarRemoved = false;
  const preview = document.getElementById("avatar-preview-large");
  if (preview) preview.innerHTML = renderAvatarHtml(currentProfile, 120);
  const fileInput = document.getElementById("avatar-file-input");
  if (fileInput) fileInput.value = "";
  document.getElementById("avatar-modal").classList.remove("hidden");
}
window.openAvatarModal = openAvatarModal;

function closeAvatarModal() {
  pendingAvatarFile = null;
  pendingAvatarRemoved = false;
  document.getElementById("avatar-modal").classList.add("hidden");
}
window.closeAvatarModal = closeAvatarModal;

async function saveAvatar() {
  const btn = document.getElementById("avatar-save-btn");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    let newUrl = currentProfile.avatar_url || null;

    if (pendingAvatarFile) {
      const file = pendingAvatarFile;
      if (file.size > 2 * 1024 * 1024) throw new Error("Image is over 2 MB — please pick a smaller one.");
      if (!file.type.startsWith("image/")) throw new Error("Please choose an image file.");
      const ext = (file.name.split(".").pop() || "png").toLowerCase();
      const path = `${currentProfile.id}/avatar-${Date.now()}.${ext}`;
      const { error: upErr } = await supabaseClient.storage
        .from("avatars").upload(path, file, { cacheControl: "3600", upsert: true });
      if (upErr) throw upErr;
      const { data: urlData } = supabaseClient.storage.from("avatars").getPublicUrl(path);
      newUrl = urlData.publicUrl;
    } else if (pendingAvatarRemoved) {
      newUrl = null;
    }

    const { error: updateErr } = await supabaseClient
      .from("profiles").update({ avatar_url: newUrl }).eq("id", currentProfile.id);
    if (updateErr) throw updateErr;

    currentProfile.avatar_url = newUrl;
    refreshHeaderAvatar();
    showToast(pendingAvatarRemoved ? "Avatar removed." : "Avatar updated!", "success");
    closeAvatarModal();

    // Refresh whatever view is currently open so avatars stay in sync.
    const view = document.querySelector(".view-panel:not(.hidden)")?.id;
    if (view === "view-challenges") renderClassmateList();
    if (view === "view-global-dashboard") { renderGlobalPodium(); renderGlobalLeaderboard(); }
    if (view === "view-class-dashboard") loadStudentClassDashboard();
    if (view === "view-teacher-class") loadTeacherClassView();
    if (view === "view-certificates") loadCertificatesView();
  } catch (err) {
    showToast(err.message || "Avatar upload failed.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ----------------------------------------------------------------------------
// Auth
// ----------------------------------------------------------------------------
async function checkSessionAndBoot() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) { showAuthView(); return; }
  currentUser = session.user;
  const { data: profile, error } = await supabaseClient
    .from("profiles").select("*").eq("id", currentUser.id).single();
  if (error || !profile) {
    showToast("Could not load profile. Please sign in again.", "error");
    await supabaseClient.auth.signOut();
    showAuthView();
    return;
  }
  currentProfile = profile;
  await bootRoleWorkspace();
}
function showAuthView() {
  currentUser = null; currentProfile = null;
  stopPresenceTracking();
  if (unreadPollTimer) clearInterval(unreadPollTimer);
  if (typeof certificatesRefreshTimer !== "undefined" && certificatesRefreshTimer) {
    clearInterval(certificatesRefreshTimer);
    certificatesRefreshTimer = null;
  }
  document.getElementById("auth-section").classList.remove("hidden");
  document.getElementById("app-section").classList.add("hidden");
}
async function bootRoleWorkspace() {
  document.getElementById("auth-section").classList.add("hidden");
  document.getElementById("app-section").classList.remove("hidden");

  const roleBadge = document.getElementById("header-role-badge");
  roleBadge.textContent = currentProfile.role.toUpperCase();
  roleBadge.className = `badge badge-${currentProfile.role}`;
  document.getElementById("header-user-name").textContent = currentProfile.full_name;
  document.getElementById("header-school-badge").textContent =
    currentProfile.school_name || (currentProfile.role === "owner" ? "Platform Owner" : "");
  refreshHeaderAvatar();

  const scorePill = document.getElementById("header-score-badge");
  if (currentProfile.role === "student") {
    scorePill.textContent = `${currentProfile.score} pts`;
    scorePill.classList.remove("hidden");
  } else scorePill.classList.add("hidden");

  const nav = document.getElementById("main-nav");
  let tabs = [];
  if (currentProfile.role === "owner") {
    tabs = [
      { id: "owner-questions", label: "🖼️ Questions & Topics" },
      { id: "owner-teachers", label: "👩‍🏫 Teachers & Waivers" },
      { id: "owner-hints", label: "🤖 AI Hint Log" },
      { id: "certificates", label: "🏆 Certificates" },
      { id: "global-dashboard", label: "🌍 All Students Dashboard" },
    ];
  } else if (currentProfile.role === "teacher") {
    tabs = [
      { id: "teacher-class", label: "🏫 Class Dashboard" },
      { id: "teacher-topics", label: "📚 Topics Overview" },
      { id: "teacher-hints", label: "🤖 AI Hints" },
      { id: "global-dashboard", label: "🌍 All Students Dashboard" },
    ];
  } else {
    tabs = [
      { id: "student-practice", label: "📐 Practice Topics" },
      { id: "challenges", label: "⚔️ Challenges" },
      { id: "class-dashboard", label: "🏫 Class Dashboard" },
      { id: "certificates", label: "🏆 Certificates" },
      { id: "global-dashboard", label: "🌍 All Students Dashboard" },
    ];
  }
  nav.innerHTML = tabs.map((t, i) =>
    `<button class="nav-btn ${i === 0 ? "active" : ""}" data-view="${t.id}">${t.label}</button>`
  ).join("");
  nav.querySelectorAll(".nav-btn").forEach(btn =>
    btn.addEventListener("click", () => switchWorkspaceView(btn.dataset.view)));

  await switchWorkspaceView(tabs[0].id);

  // Start realtime presence so students can see who else is online.
  if (currentProfile.role === "student") await startPresenceTracking();

  refreshUnreadBadge();
  if (unreadPollTimer) clearInterval(unreadPollTimer);
  unreadPollTimer = setInterval(refreshUnreadBadge, 30000);
}
async function switchWorkspaceView(viewId) {
  document.querySelectorAll(".nav-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.view === viewId));
  document.querySelectorAll(".view-panel").forEach(p =>
    p.classList.toggle("hidden", p.id !== `view-${viewId}`));

  if (viewId === "owner-questions") await loadOwnerQuestionsView();
  if (viewId === "owner-teachers") await loadOwnerTeachersView();
  if (viewId === "owner-hints") await loadHintsLog("owner");
  if (viewId === "teacher-class") await loadTeacherClassView();
  if (viewId === "teacher-topics") await loadTeacherTopicsView();
  if (viewId === "teacher-hints") await loadHintsLog("teacher");
  if (viewId === "student-practice") await loadStudentPracticeView();
  if (viewId === "class-dashboard") await loadStudentClassDashboard();
  if (viewId === "global-dashboard") await loadGlobalDashboard();
  if (viewId === "certificates") await loadCertificatesView();
  if (viewId === "challenges") await loadChallengesView();

  const regenBtn = document.getElementById("owner-regenerate-certificates-btn");
  if (regenBtn) {
    regenBtn.classList.toggle("hidden",
      !(currentProfile.role === "owner" && viewId === "certificates"));
  }
  if (viewId !== "challenges" && typeof summaryPollTimer !== "undefined" && summaryPollTimer) {
    clearInterval(summaryPollTimer);
    summaryPollTimer = null;
  }
  if (viewId !== "certificates" && typeof certificatesRefreshTimer !== "undefined" && certificatesRefreshTimer) {
    clearInterval(certificatesRefreshTimer);
    certificatesRefreshTimer = null;
  }
}

// ----------------------------------------------------------------------------
// Static events
// ----------------------------------------------------------------------------
function bindStaticEvents() {
  document.querySelectorAll(".auth-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".auth-form").forEach(f => f.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`${tab.dataset.authTab}-form`).classList.add("active");
    });
  });
  const openConfig = () => {
    const { url, key } = getSupabaseConfig();
    document.getElementById("supabase-url-input").value = url;
    document.getElementById("supabase-key-input").value = key;
    document.getElementById("config-modal").classList.remove("hidden");
  };
  document.getElementById("open-config-btn").addEventListener("click", openConfig);
  document.getElementById("auth-config-trigger").addEventListener("click", openConfig);
  document.getElementById("close-config-modal").addEventListener("click", () =>
    document.getElementById("config-modal").classList.add("hidden"));

  document.getElementById("config-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    localStorage.setItem("cm_supabase_url", document.getElementById("supabase-url-input").value.trim());
    localStorage.setItem("cm_supabase_key", document.getElementById("supabase-key-input").value.trim());
    document.getElementById("config-modal").classList.add("hidden");
    if (initSupabase()) { showToast("Supabase connected!", "success"); await checkSessionAndBoot(); }
  });
  document.getElementById("student-login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!supabaseClient) return showToast("Connect Supabase first.", "error");
    const { clean, email } = usernameToEmail(document.getElementById("student-username").value);
    if (!clean) return showToast("Enter a valid username.", "error");
    const { error } = await supabaseClient.auth.signInWithPassword({
      email, password: document.getElementById("student-password").value,
    });
    if (error) return showToast("Invalid username or password.", "error");
    showToast("Welcome back!", "success");
    await checkSessionAndBoot();
  });
  document.getElementById("staff-login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!supabaseClient) return showToast("Connect Supabase first.", "error");
    const { error } = await supabaseClient.auth.signInWithPassword({
      email: document.getElementById("staff-email").value.trim(),
      password: document.getElementById("staff-password").value,
    });
    if (error) return showToast(error.message, "error");
    showToast("Signed in successfully!", "success");
    await checkSessionAndBoot();
  });
  document.getElementById("teacher-signup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!supabaseClient) return showToast("Connect Supabase first.", "error");
    const { data, error } = await supabaseClient.auth.signUp({
      email: document.getElementById("teacher-email").value.trim(),
      password: document.getElementById("teacher-password").value,
      options: { data: {
        role: "teacher",
        full_name: document.getElementById("teacher-name").value.trim(),
        school_name: document.getElementById("teacher-school").value.trim(),
      } },
    });
    if (error) return showToast(error.message, "error");
    if (data.session) { showToast("Account created!", "success"); await checkSessionAndBoot(); }
    else showToast("Account created! Confirm email or disable confirmation.", "info");
  });
  document.getElementById("logout-btn").addEventListener("click", async () => {
    await supabaseClient.auth.signOut();
    showToast("Signed out.", "info");
    showAuthView();
  });

  document.getElementById("q-image-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    const wrap = document.getElementById("q-image-preview-wrap");
    if (!file) return wrap.classList.add("hidden");
    document.getElementById("q-image-preview").src = URL.createObjectURL(file);
    wrap.classList.remove("hidden");
  });
  document.getElementById("add-answer-group-btn").addEventListener("click", () => {
    const raw = document.getElementById("new-group-values").value.trim();
    if (!raw) return;
    const values = raw.split(",").map(s => s.trim()).filter(Boolean);
    if (!values.length) return;
    pendingAnswerGroups.push({ values });
    document.getElementById("new-group-values").value = "";
    renderAnswerGroups();
  });
  document.getElementById("new-group-values").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); document.getElementById("add-answer-group-btn").click(); }
  });

  document.getElementById("add-topic-form").addEventListener("submit", handleOwnerCreateTopic);
  document.getElementById("add-question-form").addEventListener("submit", handleOwnerPublishQuestion);
  document.getElementById("owner-questions-filter-topic").addEventListener("change", renderOwnerQuestions);
  document.getElementById("create-student-form").addEventListener("submit", handleTeacherCreateStudent);
  document.getElementById("teacher-class-search").addEventListener("input", renderTeacherClassTable);

  const excelBtn = document.getElementById("export-excel-btn");
  const pdfBtn = document.getElementById("export-pdf-btn");
  if (excelBtn) excelBtn.addEventListener("click", exportClassDashboardExcel);
  if (pdfBtn) pdfBtn.addEventListener("click", exportClassDashboardPDF);

  const regenBtn = document.getElementById("owner-regenerate-certificates-btn");
  if (regenBtn) {
    regenBtn.addEventListener("click", async () => {
      if (!confirm("Generate this week's certificates now?")) return;
      regenBtn.disabled = true;
      const original = regenBtn.textContent;
      regenBtn.textContent = "Generating…";
      try {
        const { data, error } = await supabaseClient.rpc("generate_weekly_certificates_now");
        if (error) throw error;
        showToast(`Generated ${data ?? 0} certificate(s).`, "success");
        await loadCertificatesView();
      } catch (err) {
        showToast(err.message || "Failed.", "error");
      } finally {
        regenBtn.disabled = false;
        regenBtn.textContent = original;
      }
    });
  }

  document.getElementById("back-to-topics-btn").addEventListener("click", () => {
    activeTopicId = null;
    document.getElementById("student-topic-questions-area").classList.add("hidden");
    document.getElementById("student-topics-grid").classList.remove("hidden");
  });
  document.getElementById("student-q-filter").addEventListener("change", renderStudentTopicQuestions);
  document.getElementById("global-search").addEventListener("input", renderGlobalLeaderboard);

  document.getElementById("close-image-modal").addEventListener("click", () =>
    document.getElementById("image-modal").classList.add("hidden"));
  document.querySelector("#image-modal .modal-backdrop").addEventListener("click", () =>
    document.getElementById("image-modal").classList.add("hidden"));

  document.getElementById("inbox-btn").addEventListener("click", openInbox);
  document.getElementById("close-inbox-modal").addEventListener("click", () =>
    document.getElementById("inbox-modal").classList.add("hidden"));
  document.querySelector("#inbox-modal .modal-backdrop").addEventListener("click", () =>
    document.getElementById("inbox-modal").classList.add("hidden"));
  document.getElementById("inbox-send-form").addEventListener("submit", handleInboxSend);
  document.getElementById("challenge-classmate-search")?.addEventListener("input", renderClassmateList);
  document.getElementById("close-challenge-room")?.addEventListener("click", closeChallengeRoom);
  document.querySelector("#challenge-room-modal .modal-backdrop")?.addEventListener("click", closeChallengeRoom);

  // Avatar modal
  document.getElementById("user-pill")?.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    openAvatarModal();
  });
  document.getElementById("close-avatar-modal")?.addEventListener("click", closeAvatarModal);
  document.querySelector("#avatar-modal .modal-backdrop")?.addEventListener("click", closeAvatarModal);
  document.getElementById("avatar-choose-btn")?.addEventListener("click", () => {
    document.getElementById("avatar-file-input").click();
  });
  document.getElementById("avatar-file-input")?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pendingAvatarFile = file;
    pendingAvatarRemoved = false;
    const preview = document.getElementById("avatar-preview-large");
    const url = URL.createObjectURL(file);
    preview.innerHTML = `<span class="avatar" style="width:120px;height:120px;"><img src="${url}" alt="" /></span>`;
  });
  document.getElementById("avatar-remove-btn")?.addEventListener("click", () => {
    pendingAvatarFile = null;
    pendingAvatarRemoved = true;
    document.getElementById("avatar-file-input").value = "";
    const preview = document.getElementById("avatar-preview-large");
    preview.innerHTML = renderAvatarHtml({ full_name: currentProfile?.full_name || "?" }, 120);
  });
  document.getElementById("avatar-save-btn")?.addEventListener("click", saveAvatar);

  renderAnswerGroups();
}

function openImageZoom(url) {
  document.getElementById("modal-img").src = url;
  document.getElementById("image-modal").classList.remove("hidden");
}
window.openImageZoom = openImageZoom;

// ----------------------------------------------------------------------------
// Answer groups
// ----------------------------------------------------------------------------
function renderAnswerGroups() {
  const c = document.getElementById("answer-groups-container");
  if (!c) return;
  if (!pendingAnswerGroups.length) {
    c.innerHTML = `<p class="muted" style="font-size:0.85rem;margin:0 0 4px;">No answer groups yet.</p>`;
    return;
  }
  c.innerHTML = pendingAnswerGroups.map((g, i) => `
    <div class="answer-group-item">
      <span class="required-badge">SLOT ${i + 1}</span>
      ${g.values.map(v => `<span class="answer-chip">${escapeHtml(v)}</span>`).join(" ")}
      <button type="button" class="btn btn-danger btn-sm"
        onclick="removeAnswerGroup(${i})" style="margin-left:auto;">×</button>
    </div>`).join("");
}
window.removeAnswerGroup = (i) => { pendingAnswerGroups.splice(i, 1); renderAnswerGroups(); };

// ----------------------------------------------------------------------------
// Owner: Questions
// ----------------------------------------------------------------------------
async function loadOwnerQuestionsView() {
  const [topicsRes, questionsRes, answersRes] = await Promise.all([
    supabaseClient.from("topics").select("*").order("name"),
    supabaseClient.from("questions").select("*").order("created_at", { ascending: false }),
    supabaseClient.from("question_answers").select("*"),
  ]);
  allTopics = topicsRes.data || [];
  const answerMap = new Map((answersRes.data || []).map(a => [a.question_id, a.answer_groups || []]));
  allQuestions = (questionsRes.data || []).map(q => ({ ...q, answer_groups: answerMap.get(q.id) || [] }));

  document.getElementById("q-topic").innerHTML = allTopics.map(t =>
    `<option value="${t.id}">${escapeHtml(t.icon)} ${escapeHtml(t.name)}</option>`).join("");
  document.getElementById("owner-questions-filter-topic").innerHTML =
    `<option value="all">All Topics</option>` +
    allTopics.map(t => `<option value="${t.id}">${escapeHtml(t.icon)} ${escapeHtml(t.name)}</option>`).join("");

  document.getElementById("owner-topics-list").innerHTML = allTopics.map(t => `
    <div class="topic-mini-item">
      <div><strong>${escapeHtml(t.icon)} ${escapeHtml(t.name)}</strong>
      <div class="muted">${escapeHtml(t.stage_group)}</div></div>
      <button class="btn btn-danger btn-sm" onclick="deleteTopic('${t.id}')">Delete</button>
    </div>`).join("");

  renderOwnerQuestions();
}
async function handleOwnerCreateTopic(e) {
  e.preventDefault();
  const { error } = await supabaseClient.from("topics").insert({
    name: document.getElementById("topic-name").value.trim(),
    icon: document.getElementById("topic-icon").value.trim() || "📐",
    stage_group: document.getElementById("topic-stage").value.trim(),
    description: document.getElementById("topic-desc").value.trim(),
  });
  if (error) return showToast(error.message, "error");
  showToast("Topic created!", "success");
  e.target.reset();
  document.getElementById("topic-icon").value = "📏";
  document.getElementById("topic-stage").value = "Primary & Lower Secondary";
  await loadOwnerQuestionsView();
}
window.deleteTopic = async (id) => {
  if (!confirm("Delete topic and all its questions?")) return;
  const { error } = await supabaseClient.from("topics").delete().eq("id", id);
  if (error) return showToast(error.message, "error");
  showToast("Topic deleted.", "info");
  await loadOwnerQuestionsView();
};

async function handleOwnerPublishQuestion(e) {
  e.preventDefault();
  if (!pendingAnswerGroups.length) return showToast("Add at least one answer group.", "error");
  const file = document.getElementById("q-image-file").files[0];
  if (!file) return showToast("Choose a question image.", "error");
  const btn = document.getElementById("publish-question-btn");
  btn.disabled = true; btn.textContent = "Uploading...";
  try {
    const ext = file.name.split(".").pop() || "png";
    const path = `questions/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const { error: upErr } = await supabaseClient.storage.from("question-images")
      .upload(path, file, { cacheControl: "3600", upsert: false });
    if (upErr) throw upErr;
    const { data: urlData } = supabaseClient.storage.from("question-images").getPublicUrl(path);
    const { error: rpcErr } = await supabaseClient.rpc("owner_create_question", {
      p_topic_id: document.getElementById("q-topic").value,
      p_title: document.getElementById("q-title").value.trim(),
      p_stage: document.getElementById("q-stage").value,
      p_image_url: urlData.publicUrl,
      p_points: Number(document.getElementById("q-points").value) || 10,
      p_answer_groups: pendingAnswerGroups,
      p_require_multi: document.getElementById("q-require-multi").checked,
    });
    if (rpcErr) throw rpcErr;
    showToast("Question published!", "success");
    e.target.reset();
    pendingAnswerGroups = [];
    renderAnswerGroups();
    document.getElementById("q-image-preview-wrap").classList.add("hidden");
    await loadOwnerQuestionsView();
  } catch (err) {
    showToast(err.message || "Publish failed.", "error");
  } finally {
    btn.disabled = false; btn.textContent = "Publish Question";
  }
}
function renderOwnerQuestions() {
  const fid = document.getElementById("owner-questions-filter-topic").value;
  const map = new Map(allTopics.map(t => [t.id, t]));
  const filtered = fid === "all" ? allQuestions : allQuestions.filter(q => q.topic_id === fid);
  const c = document.getElementById("owner-questions-list");
  if (!filtered.length) { c.innerHTML = `<p class="muted">No questions yet.</p>`; return; }
  c.innerHTML = filtered.map(q => {
    const topic = map.get(q.topic_id);
    const groups = (q.answer_groups || []).map((g, i) => `
      <div class="group-preview-row">
        <span class="required-badge">SLOT ${i + 1}</span>
        ${(g.values || []).map(v => `<span class="answer-chip">${escapeHtml(v)}</span>`).join(" ")}
      </div>`).join("");
    return `
      <div class="question-card">
        <div class="question-img-box" onclick="openImageZoom('${escapeHtml(q.image_url)}')">
          <img src="${escapeHtml(q.image_url)}" alt="${escapeHtml(q.title)}" />
        </div>
        <div class="question-body">
          <div class="question-meta">
            <span class="stage-tag">${escapeHtml(q.stage)}</span>
            <span class="points-tag">${q.points} pts</span>
            ${q.require_multi_answers ? `<span class="stage-tag">Multi</span>` : ""}
          </div>
          <strong>${escapeHtml(q.title)}</strong>
          <small class="muted">${topic ? `${escapeHtml(topic.icon)} ${escapeHtml(topic.name)}` : ""}</small>
          <div class="group-preview">${groups}</div>
          <button class="btn btn-danger btn-sm mt-lg" onclick="deleteQuestion('${q.id}')">Delete</button>
        </div>
      </div>`;
  }).join("");
}
window.deleteQuestion = async (id) => {
  if (!confirm("Delete question?")) return;
  const { error } = await supabaseClient.from("questions").delete().eq("id", id);
  if (error) return showToast(error.message, "error");
  showToast("Question deleted.", "info");
  await loadOwnerQuestionsView();
};

// ----------------------------------------------------------------------------
// Owner: Teachers
// ----------------------------------------------------------------------------
async function loadOwnerTeachersView() {
  const { data: profiles, error } = await supabaseClient
    .from("profiles").select("*").in("role", ["teacher", "student"])
    .order("created_at", { ascending: false });
  if (error) return showToast(error.message, "error");
  const teachers = (profiles || []).filter(p => p.role === "teacher");
  const students = (profiles || []).filter(p => p.role === "student");
  const counts = {};
  students.forEach(s => { counts[s.teacher_id] = (counts[s.teacher_id] || 0) + 1; });

  document.getElementById("owner-stat-teachers").textContent = teachers.length;
  document.getElementById("owner-stat-waived").textContent = teachers.filter(t => t.subscription_waived).length;
  document.getElementById("owner-stat-students").textContent = students.length;

  const tbody = document.getElementById("owner-teachers-tbody");
  if (!teachers.length) { tbody.innerHTML = `<tr><td colspan="6" class="muted">No teachers yet.</td></tr>`; return; }
  tbody.innerHTML = teachers.map(t => {
    const days = daysLeftInTrial(t.trial_ends_at);
    const badge = t.subscription_waived
      ? `<span class="badge badge-success">Waived</span>`
      : days > 0 ? `<span class="badge badge-warning">Trial ${days}d</span>`
      : `<span class="badge badge-danger">Expired</span>`;
    return `
      <tr>
        <td>
          <div class="table-user">
            ${renderAvatarHtml(t, 32)}
            <div>
              <strong>${escapeHtml(t.full_name)}</strong><br/>
              <small class="muted">${escapeHtml(t.email || "")}</small>
            </div>
          </div>
        </td>
        <td>${escapeHtml(t.school_name || "—")}</td>
        <td>${counts[t.id] || 0}</td>
        <td>${t.trial_ends_at ? new Date(t.trial_ends_at).toLocaleDateString() : "—"}</td>
        <td>${badge}</td>
        <td><button class="btn btn-sm ${t.subscription_waived ? "btn-outline" : "btn-amber"}"
          onclick="toggleWaiveSubscription('${t.id}', ${!t.subscription_waived})">
          ${t.subscription_waived ? "Revoke" : "Waive Fee"}</button></td>
      </tr>`;
  }).join("");
}
window.toggleWaiveSubscription = async (id, waive) => {
  const { error } = await supabaseClient.from("profiles").update({ subscription_waived: waive }).eq("id", id);
  if (error) return showToast(error.message, "error");
  showToast(waive ? "Fee waived!" : "Waiver removed.", "success");
  await loadOwnerTeachersView();
};

// ----------------------------------------------------------------------------
// Hint log
// ----------------------------------------------------------------------------
async function loadHintsLog(role) {
  const tbodyId = role === "owner" ? "owner-hints-tbody" : "teacher-hints-tbody";
  const tbody = document.getElementById(tbodyId);
  const { data, error } = await supabaseClient.rpc("teacher_hint_log", { p_limit: 200 });
  if (error) { tbody.innerHTML = `<tr><td colspan="5" class="muted">${escapeHtml(error.message)}</td></tr>`; return; }
  if (!data || !data.length) { tbody.innerHTML = `<tr><td colspan="5" class="muted">No AI hints yet.</td></tr>`; return; }
  tbody.innerHTML = data.map(h => `
    <tr>
      <td>${fmtDate(h.created_at)}</td>
      <td>${escapeHtml(h.student_name)}</td>
      <td>${escapeHtml(h.question_title)}</td>
      <td><code>${escapeHtml(h.submitted_answer)}</code></td>
      <td class="hint-cell">${escapeHtml(h.hint_text)}</td>
    </tr>`).join("");
}

// ----------------------------------------------------------------------------
// Teacher: Class
// ----------------------------------------------------------------------------
async function loadTeacherClassView() {
  const { data: fresh } = await supabaseClient.from("profiles").select("*").eq("id", currentProfile.id).single();
  if (fresh) currentProfile = fresh;
  refreshHeaderAvatar();
  const school = document.getElementById("new-student-school");
  if (!school.value) school.value = currentProfile.school_name || "";

  const banner = document.getElementById("teacher-trial-banner");
  const active = isTeacherSubscriptionActive(currentProfile);
  const days = daysLeftInTrial(currentProfile.trial_ends_at);
  if (currentProfile.subscription_waived) {
    banner.className = "trial-banner trial-waived";
    banner.innerHTML = `<span>✅ Subscription Fee Waived — Full Lifetime Access</span>`;
  } else if (active) {
    banner.className = "trial-banner trial-active";
    banner.innerHTML = `<span>🎁 Trial: <strong>${days} day(s)</strong> left</span>`;
  } else {
    banner.className = "trial-banner trial-expired";
    banner.innerHTML = `<span>⚠️ Trial expired. Ask Owner to waive your fee.</span>`;
  }
  document.getElementById("create-student-btn").disabled = !active;

  const { data: students, error } = await supabaseClient
    .from("profiles").select("*").eq("role", "student").eq("teacher_id", currentProfile.id)
    .order("score", { ascending: false });
  if (error) return showToast(error.message, "error");
  teacherStudentsCache = students || [];
  const count = teacherStudentsCache.length;
  const total = teacherStudentsCache.reduce((a, s) => a + (s.score || 0), 0);
  document.getElementById("teacher-stat-count").textContent = count;
  document.getElementById("teacher-stat-avg").textContent = count ? Math.round(total / count) : 0;
  document.getElementById("teacher-stat-top").textContent = count ? teacherStudentsCache[0].score : 0;
  renderTeacherClassTable();
}
function renderTeacherClassTable() {
  const q = document.getElementById("teacher-class-search").value.trim().toLowerCase();
  const tbody = document.getElementById("teacher-class-tbody");
  const ranked = teacherStudentsCache.map((s, i) => ({ ...s, rank: i + 1 }));
  const filtered = q
    ? ranked.filter(s => s.full_name.toLowerCase().includes(q)
      || (s.username || "").toLowerCase().includes(q)
      || (s.school_name || "").toLowerCase().includes(q))
    : ranked;
  if (!filtered.length) { tbody.innerHTML = `<tr><td colspan="7" class="muted">No students.</td></tr>`; return; }
  tbody.innerHTML = filtered.map(s => `
    <tr>
      <td><strong>${formatRankMedal(s.rank)}</strong></td>
      <td>
        <div class="table-user">
          ${renderAvatarHtml(s, 32)}
          <span>${escapeHtml(s.full_name)}</span>
        </div>
      </td>
      <td><code>${escapeHtml(s.username || "")}</code></td>
      <td>${escapeHtml(s.school_name || "—")}</td>
      <td>${s.questions_solved}</td>
      <td><strong>${s.score} pts</strong></td>
      <td class="table-actions">
        <button class="btn btn-outline btn-sm" onclick="openInboxWith('${s.id}')">💬</button>
        <button class="btn btn-danger btn-sm"
          onclick="deleteStudent('${s.id}', '${escapeHtml(s.full_name).replace(/'/g, "\\'")}')">Delete</button>
      </td>
    </tr>`).join("");
}
window.deleteStudent = async (id, name) => {
  if (!confirm(`Delete student "${name}"?`)) return;
  const { error } = await supabaseClient.rpc("teacher_delete_student", { p_student_id: id });
  if (error) return showToast(error.message, "error");
  showToast("Student deleted.", "success");
  await loadTeacherClassView();
};
async function handleTeacherCreateStudent(e) {
  e.preventDefault();
  if (!isTeacherSubscriptionActive(currentProfile))
    return showToast("Trial expired. Ask Owner to waive your fee.", "error");
  const { clean, email } = usernameToEmail(document.getElementById("new-student-username").value);
  if (clean.length < 3) return showToast("Username 3+ chars.", "error");
  const btn = document.getElementById("create-student-btn");
  btn.disabled = true; btn.textContent = "Creating...";
  try {
    const { data: existing } = await supabaseClient.from("profiles").select("id").eq("username", clean).maybeSingle();
    if (existing) throw new Error(`Username "${clean}" taken.`);
    const { error } = await studentSignupClient.auth.signUp({
      email,
      password: document.getElementById("new-student-password").value,
      options: { data: {
        role: "student",
        full_name: document.getElementById("new-student-name").value.trim(),
        username: clean,
        school_name: document.getElementById("new-student-school").value.trim(),
        teacher_id: currentProfile.id,
      } },
    });
    if (error) throw error;
    showToast(`Student created! Username: ${clean}`, "success");
    e.target.reset();
    document.getElementById("new-student-school").value = currentProfile.school_name || "";
    await loadTeacherClassView();
  } catch (err) {
    showToast(err.message || "Create failed.", "error");
  } finally {
    btn.disabled = false; btn.textContent = "Create Student Account";
  }
}

// ----------------------------------------------------------------------------
// Teacher: Topics overview
// ----------------------------------------------------------------------------
async function loadTeacherTopicsView() {
  const tbody = document.getElementById("teacher-topics-tbody");
  const { data, error } = await supabaseClient.rpc("teacher_topic_stats");
  if (error) { tbody.innerHTML = `<tr><td colspan="4" class="muted">${escapeHtml(error.message)}</td></tr>`; return; }
  if (!data || !data.length) { tbody.innerHTML = `<tr><td colspan="4" class="muted">No topics yet.</td></tr>`; return; }
  tbody.innerHTML = data.map(t => `
    <tr>
      <td><strong>${escapeHtml(t.topic_icon)} ${escapeHtml(t.topic_name)}</strong></td>
      <td>${escapeHtml(t.topic_stage_group)}</td>
      <td>${t.question_count}</td>
      <td>${t.solved_by_class}</td>
    </tr>`).join("");
}

// ----------------------------------------------------------------------------
// Student: Practice
// ----------------------------------------------------------------------------
async function loadStudentPracticeView() {
  const [topicsRes, qRes, attRes, profRes, cntRes] = await Promise.all([
    supabaseClient.from("topics").select("*").order("name"),
    supabaseClient.from("questions").select("*").order("created_at", { ascending: true }),
    supabaseClient.from("student_attempts").select("question_id, is_correct")
      .eq("student_id", currentProfile.id).eq("is_correct", true),
    supabaseClient.from("profiles").select("score, questions_solved, avatar_url").eq("id", currentProfile.id).single(),
    supabaseClient.rpc("get_question_answer_counts"),
  ]);
  if (profRes.data) {
    currentProfile.score = profRes.data.score;
    currentProfile.questions_solved = profRes.data.questions_solved;
    if (profRes.data.avatar_url !== undefined) currentProfile.avatar_url = profRes.data.avatar_url;
  }
  refreshHeaderAvatar();
  document.getElementById("student-my-score").textContent = currentProfile.score;
  document.getElementById("student-my-solved").textContent = currentProfile.questions_solved;
  document.getElementById("header-score-badge").textContent = `${currentProfile.score} pts`;

  const counts = new Map((cntRes.data || []).map(r => [r.question_id, Number(r.required_count) || 0]));
  allTopics = topicsRes.data || [];
  allQuestions = (qRes.data || []).map(q => ({ ...q, slot_count: counts.get(q.id) || 0 }));
  mySolvedQuestionIds = new Set((attRes.data || []).map(a => a.question_id));
  renderStudentTopicsGrid();
  if (activeTopicId) renderStudentTopicQuestions();
}
function renderStudentTopicsGrid() {
  const grid = document.getElementById("student-topics-grid");
  if (!allTopics.length) { grid.innerHTML = `<p class="muted">No topics yet.</p>`; return; }
  grid.innerHTML = allTopics.map(t => {
    const tq = allQuestions.filter(q => q.topic_id === t.id);
    const solved = tq.filter(q => mySolvedQuestionIds.has(q.id)).length;
    return `
      <div class="topic-card" onclick="openStudentTopic('${t.id}')">
        <div class="topic-icon">${escapeHtml(t.icon)}</div>
        <h3>${escapeHtml(t.name)}</h3>
        <p>${escapeHtml(t.description || t.stage_group)}</p>
        <div class="topic-progress">
          <span>${tq.length} Question(s)</span><span>✅ ${solved} Solved</span>
        </div>
      </div>`;
  }).join("");
}
window.openStudentTopic = (id) => {
  activeTopicId = id;
  const t = allTopics.find(x => x.id === id);
  document.getElementById("active-topic-heading").textContent = t ? `${t.icon} ${t.name}` : "Questions";
  document.getElementById("student-topics-grid").classList.add("hidden");
  document.getElementById("student-topic-questions-area").classList.remove("hidden");
  renderStudentTopicQuestions();
};
function renderStudentTopicQuestions() {
  const filter = document.getElementById("student-q-filter").value;
  let qs = allQuestions.filter(q => q.topic_id === activeTopicId);
  if (filter === "solved") qs = qs.filter(q => mySolvedQuestionIds.has(q.id));
  if (filter === "unsolved") qs = qs.filter(q => !mySolvedQuestionIds.has(q.id));
  const c = document.getElementById("student-questions-list");
  if (!qs.length) { c.innerHTML = `<p class="muted">No questions match.</p>`; return; }
  c.innerHTML = qs.map(q => {
    const solved = mySolvedQuestionIds.has(q.id);
    const slots = q.slot_count || 0;
    let inputs = "";
    if (slots > 0) {
      for (let i = 0; i < slots; i++) {
        inputs += `
          <label class="answer-slot-label">Answer #${i + 1}</label>
          <input type="text" class="answer-slot" data-qid="${q.id}" data-index="${i}"
                 placeholder="Answer ${i + 1}" ${solved ? "disabled" : ""} />`;
      }
    } else {
      inputs = `<label class="answer-slot-label">Answer</label>
        <input type="text" class="answer-slot" data-qid="${q.id}" data-index="0"
               placeholder="Enter your answer..." ${solved ? "disabled" : ""} />`;
    }
    return `
      <div class="question-card ${solved ? "solved" : ""}" id="q-card-${q.id}">
        <div class="question-img-box" onclick="openImageZoom('${escapeHtml(q.image_url)}')">
          <img src="${escapeHtml(q.image_url)}" alt="${escapeHtml(q.title)}" />
        </div>
        <div class="question-body">
          <div class="question-meta">
            <span class="stage-tag">${escapeHtml(q.stage)}</span>
            <span class="points-tag">${solved ? "✅ Solved" : `+${q.points} pts`}</span>
            ${slots > 1 ? `<span class="stage-tag">${slots} answers</span>` : ""}
          </div>
          <strong>${escapeHtml(q.title)}</strong>
          <form class="student-answer-form" onsubmit="handleStudentSubmitAnswer(event, '${q.id}')">
            ${inputs}
            <button type="submit" class="btn btn-primary btn-sm" ${solved ? "disabled" : ""}>
              ${solved ? "✅ Solved" : "Check"}
            </button>
          </form>
          <div id="feedback-${q.id}" class="attempt-feedback hidden"></div>
          <div id="hint-${q.id}" class="ai-hint-bubble hidden"></div>
        </div>
      </div>`;
  }).join("");
}

window.handleStudentSubmitAnswer = async (e, questionId) => {
  e.preventDefault();
  const form = e.target;
  const feedback = document.getElementById(`feedback-${questionId}`);
  const hintBox = document.getElementById(`hint-${questionId}`);
  hintBox.classList.add("hidden");
  hintBox.textContent = "";

  const inputs = Array.from(form.querySelectorAll("input.answer-slot"));
  const answers = inputs.map(i => i.value.trim());
  if (answers.some(a => !a)) return showToast("Fill in every answer box.", "error");

  const payload = JSON.stringify(answers);
  const { data, error } = await supabaseClient.rpc("submit_answer", {
    p_question_id: questionId, p_answer: payload,
  });
  if (error) return showToast(error.message, "error");

  feedback.classList.remove("hidden", "ok", "bad");
  if (data.is_correct) {
    mySolvedQuestionIds.add(questionId);
    currentProfile.score = data.new_score;
    currentProfile.questions_solved = data.questions_solved;
    document.getElementById("student-my-score").textContent = data.new_score;
    document.getElementById("student-my-solved").textContent = data.questions_solved;
    document.getElementById("header-score-badge").textContent = `${data.new_score} pts`;
    document.getElementById(`q-card-${questionId}`).classList.add("solved");
    form.querySelectorAll("input").forEach(i => i.disabled = true);
    const btn = form.querySelector("button");
    btn.textContent = "✅ Solved"; btn.disabled = true;
    feedback.classList.add("ok");
    feedback.textContent = data.points_awarded > 0
      ? `🎉 Correct! +${data.points_awarded} points!`
      : `✅ Correct! (Already awarded)`;
    if (data.points_awarded > 0) showToast(`+${data.points_awarded} points!`, "success");
    renderStudentTopicsGrid();
  } else {
    feedback.classList.add("bad");
    feedback.textContent = "❌ Not quite right. Getting a hint...";
    hintBox.classList.remove("hidden");
    hintBox.innerHTML = `<span class="hint-loading">🤖 Thinking…</span>`;
    const { data: sessionData } = await supabaseClient.auth.getSession();
    const token = sessionData?.session?.access_token;
    if (!token) {
      hintBox.textContent = "Please sign out and sign back in to get hints.";
      return;
    }
    const cfg = getSupabaseConfig();
    try {
      const resp = await fetch(`${cfg.url}/functions/v1/ai-hint`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "apikey": cfg.key,
        },
        body: JSON.stringify({ question_id: questionId, student_answer: answers.join(" | ") }),
      });
      const j = await resp.json();
      hintBox.textContent = j.hint || "Try re-reading the question and checking each step.";
    } catch {
      hintBox.textContent = "Try re-reading the question and checking each step.";
    }
  }
};

// ----------------------------------------------------------------------------
// Student class dashboard
// ----------------------------------------------------------------------------
async function loadStudentClassDashboard() {
  if (!currentProfile.teacher_id) {
    document.getElementById("student-class-tbody").innerHTML =
      `<tr><td colspan="5" class="muted">No teacher assigned.</td></tr>`;
    return;
  }
  const [classRes, teacherRes] = await Promise.all([
    supabaseClient.from("profiles").select("*").eq("role", "student")
      .eq("teacher_id", currentProfile.teacher_id).order("score", { ascending: false }),
    supabaseClient.from("profiles").select("full_name, school_name")
      .eq("id", currentProfile.teacher_id).maybeSingle(),
  ]);
  const list = classRes.data || [];
  if (teacherRes.data) {
    document.getElementById("student-class-subtitle").textContent =
      `Teacher: ${teacherRes.data.full_name} • ${teacherRes.data.school_name || ""}`;
  }
  const idx = list.findIndex(s => s.id === currentProfile.id);
  document.getElementById("student-class-rank-pill").textContent =
    idx >= 0 ? `Your Class Rank: #${idx + 1} of ${list.length}` : "Your Class Rank: #-";

  const tbody = document.getElementById("student-class-tbody");
  if (!list.length) { tbody.innerHTML = `<tr><td colspan="5" class="muted">No classmates.</td></tr>`; return; }
  tbody.innerHTML = list.map((s, i) => {
    const me = s.id === currentProfile.id;
    return `
      <tr class="${me ? "highlight-me" : ""}">
        <td><strong>${formatRankMedal(i + 1)}</strong></td>
        <td>
          <div class="table-user">
            ${renderAvatarHtml(s, 32)}
            <span>${escapeHtml(s.full_name)} ${me ? `<span class="badge badge-student">You</span>` : ""}</span>
          </div>
        </td>
        <td>${escapeHtml(s.school_name || "—")}</td>
        <td>${s.questions_solved}</td>
        <td><strong>${s.score} pts</strong></td>
      </tr>`;
  }).join("");
}

// ----------------------------------------------------------------------------
// Global dashboard
// ----------------------------------------------------------------------------
async function loadGlobalDashboard() {
  const { data, error } = await supabaseClient.from("profiles").select("*")
    .eq("role", "student").order("score", { ascending: false });
  if (error) return showToast(error.message, "error");
  globalStudentsCache = (data || []).map((s, i) => ({ ...s, rank: i + 1 }));
  renderGlobalPodium();
  renderGlobalLeaderboard();
}
function renderGlobalPodium() {
  const p = document.getElementById("global-podium");
  const top = globalStudentsCache.slice(0, 3);
  if (!top.length) { p.innerHTML = ""; return; }
  const medals = ["🥇", "🥈", "🥉"];
  p.innerHTML = top.map((s, i) => `
    <div class="podium-card rank-${i + 1}">
      ${renderAvatarHtml(s, 72)}
      <div class="podium-medal">${medals[i]}</div>
      <h4>#${i + 1} ${escapeHtml(s.full_name)}</h4>
      <div class="muted">${escapeHtml(s.school_name || "")}</div>
      <div class="podium-score">${s.score} pts</div>
      <small class="muted">${s.questions_solved} solved</small>
    </div>`).join("");
}
function renderGlobalLeaderboard() {
  const q = document.getElementById("global-search").value.trim().toLowerCase();
  const tbody = document.getElementById("global-leaderboard-tbody");
  const filtered = q
    ? globalStudentsCache.filter(s => s.full_name.toLowerCase().includes(q)
      || (s.school_name || "").toLowerCase().includes(q))
    : globalStudentsCache;
  if (!filtered.length) { tbody.innerHTML = `<tr><td colspan="5" class="muted">No students.</td></tr>`; return; }
  tbody.innerHTML = filtered.map(s => {
    const me = currentProfile && s.id === currentProfile.id;
    return `
      <tr class="${me ? "highlight-me" : ""}">
        <td><strong>${formatRankMedal(s.rank)}</strong></td>
        <td>
          <div class="table-user">
            ${renderAvatarHtml(s, 32)}
            <span>${escapeHtml(s.full_name)} ${me ? `<span class="badge badge-student">You</span>` : ""}</span>
          </div>
        </td>
        <td>${escapeHtml(s.school_name || "—")}</td>
        <td>${s.questions_solved}</td>
        <td><strong>${s.score} pts</strong></td>
      </tr>`;
  }).join("");
}

// ----------------------------------------------------------------------------
// Inbox / DMs
// ----------------------------------------------------------------------------
async function refreshUnreadBadge() {
  if (!currentProfile) return;
  try {
    const { data } = await supabaseClient.rpc("unread_message_count");
    const n = Number(data) || 0;
    const badge = document.getElementById("inbox-badge");
    if (n > 0) { badge.textContent = n; badge.style.display = "inline-block"; }
    else badge.style.display = "none";
  } catch { /* ignore */ }
}
async function fetchContacts() {
  const role = currentProfile.role;
  if (role === "owner") {
    const { data } = await supabaseClient.from("profiles").select("*")
      .in("role", ["teacher", "student"]).order("full_name");
    return data || [];
  }
  if (role === "teacher") {
    const [studRes, ownerRes] = await Promise.all([
      supabaseClient.from("profiles").select("*").eq("role", "student")
        .eq("teacher_id", currentProfile.id).order("full_name"),
      supabaseClient.from("profiles").select("*").eq("role", "owner"),
    ]);
    return [...(studRes.data || []), ...(ownerRes.data || [])];
  }
  // Student: their teacher + every platform owner.
  const teacherIds = [currentProfile.teacher_id].filter(Boolean);
  const [teacherRes, ownerRes] = await Promise.all([
    teacherIds.length
      ? supabaseClient.from("profiles").select("*").in("id", teacherIds)
      : Promise.resolve({ data: [] }),
    supabaseClient.from("profiles").select("*").eq("role", "owner"),
  ]);
  return [...(teacherRes.data || []), ...(ownerRes.data || [])];
}
async function openInbox() {
  document.getElementById("inbox-modal").classList.remove("hidden");
  document.getElementById("inbox-empty-hint").style.display = "block";
  activeConversationId = null;
  await renderContacts();
  await renderThread();
}
async function openInboxWith(contactId) {
  document.getElementById("inbox-modal").classList.remove("hidden");
  activeConversationId = contactId;
  await renderContacts();
  await renderThread();
}
async function renderContacts() {
  const list = await fetchContacts();

  let unreadMap = new Map();
  try {
    const { data: unreadRows } = await supabaseClient.rpc("unread_per_sender");
    (unreadRows || []).forEach(r => unreadMap.set(r.sender_id, Number(r.unread_count) || 0));
  } catch { /* ignore */ }

  const c = document.getElementById("inbox-contact-list");
  if (!list.length) { c.innerHTML = `<p class="muted" style="font-size:0.85rem;">No contacts.</p>`; return; }
  c.innerHTML = list.map(u => {
    const isActive = u.id === activeConversationId;
    const unread = unreadMap.get(u.id) || 0;
    const badge = unread > 0 ? `<span class="contact-unread-dot">${unread}</span>` : "";
    const roleIcon = u.role === "owner" ? " 👑" : u.role === "teacher" ? " 👩‍🏫" : "";
    return `
      <button class="inbox-contact ${isActive ? "active" : ""} ${unread > 0 && !isActive ? "unread" : ""}"
        onclick="selectContact('${u.id}')">
        ${renderAvatarHtml(u, 28)}
        <span style="flex:1;text-align:left;margin-left:8px;">${escapeHtml(u.full_name)}${roleIcon}</span>
        ${badge}
      </button>`;
  }).join("");
}
window.selectContact = async (id) => {
  activeConversationId = id;
  await renderContacts();
  await renderThread();
  await supabaseClient.rpc("mark_conversation_read", { p_other_id: id });
  refreshUnreadBadge();
};
async function renderThread() {
  const thread = document.getElementById("inbox-thread");
  if (!activeConversationId) {
    thread.innerHTML = `<p class="muted" style="font-size:0.85rem;">Select a contact above.</p>`;
    document.getElementById("inbox-empty-hint").style.display = "none";
    return;
  }
  document.getElementById("inbox-empty-hint").style.display = "none";
  const { data, error } = await supabaseClient.rpc("get_conversation", { p_other_id: activeConversationId });
  if (error) { thread.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`; return; }
  if (!data || !data.length) { thread.innerHTML = `<p class="muted" style="font-size:0.85rem;">No messages yet. Say hello!</p>`; return; }
  thread.innerHTML = data.map(m => {
    const me = m.sender_id === currentProfile.id;
    return `
      <div class="msg-row ${me ? "me" : "them"}">
        <div>
          <div class="msg-bubble">${escapeHtml(m.body)}</div>
          <div class="msg-meta">${fmtDate(m.created_at)}</div>
        </div>
      </div>`;
  }).join("");
  thread.scrollTop = thread.scrollHeight;
}
async function handleInboxSend(e) {
  e.preventDefault();
  if (!activeConversationId) return showToast("Select a contact first.", "error");
  const input = document.getElementById("inbox-input");
  const body = input.value.trim();
  if (!body) return;
  const { error } = await supabaseClient.rpc("send_message", {
    p_recipient_id: activeConversationId, p_body: body,
  });
  if (error) return showToast(error.message, "error");
  input.value = "";
  await renderThread();
}

// ----------------------------------------------------------------------------
// Weekly certificates — owner sees all, students see only their own
// ----------------------------------------------------------------------------
async function loadCertificatesView() {
  if (typeof certificatesRefreshTimer !== "undefined" && certificatesRefreshTimer) {
    clearInterval(certificatesRefreshTimer);
    certificatesRefreshTimer = null;
  }
  if (currentProfile.role === "owner") {
    certificatesRefreshTimer = setInterval(async () => {
      const view = document.getElementById("view-certificates");
      if (!view || view.classList.contains("hidden")) {
        clearInterval(certificatesRefreshTimer);
        certificatesRefreshTimer = null;
        return;
      }
      await loadCertificatesViewData();
    }, 60000);
  }
  await loadCertificatesViewData();
}

async function loadCertificatesViewData() {
  const container = document.getElementById("certificates-list");
  if (!container) return;
  container.innerHTML = `<p class="muted">Loading…</p>`;

  const headerP = document.querySelector("#view-certificates .panel-header p");
  if (headerP) {
    headerP.textContent = currentProfile.role === "owner"
      ? "Top 3 students by questions solved each week. Auto-generated every Thursday at 3:00 PM (Egypt time)."
      : "Your weekly achievement certificates. Only you and the platform owner can see these.";
  }

  let query = supabaseClient
    .from("weekly_certificates")
    .select("*")
    .order("week_start", { ascending: false })
    .order("rank", { ascending: true });

  if (currentProfile.role === "student") {
    query = query.eq("student_id", currentProfile.id);
  }

  const { data, error } = await query;

  if (error) {
    container.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
    return;
  }
  if (!data || data.length === 0) {
    if (currentProfile.role === "student") {
      container.innerHTML = `
        <div class="cert-empty">
          <div style="font-size:2.5rem;">🏆</div>
          <p>No certificates yet.</p>
          <p class="muted">Keep solving — the top 3 students earn a certificate every Thursday at 3:00 PM.</p>
        </div>`;
    } else {
      container.innerHTML = `
        <div class="cert-empty">
          <div style="font-size:2.5rem;">🏆</div>
          <p>No certificates yet.</p>
          <p class="muted">The first batch will be generated on the next Thursday at 3:00 PM.</p>
        </div>`;
    }
    certCache = [];
    return;
  }
  certCache = data;

  const byWeek = new Map();
  data.forEach(c => {
    if (!byWeek.has(c.week_start)) byWeek.set(c.week_start, []);
    byWeek.get(c.week_start).push(c);
  });

  const medals = { 1: "🥇", 2: "🥈", 3: "🥉" };

  container.innerHTML = Array.from(byWeek.entries()).map(([weekStart, certs]) => {
    const weekEnd = certs[0]?.week_end || weekStart;
    const cardsHtml = certs.map(c => {
      const isMe = currentProfile && c.student_id === currentProfile.id;
      return `
        <div class="cert-card rank-${c.rank} ${isMe ? "me" : ""}">
          <div class="cert-medal">${medals[c.rank] || "🏅"}</div>
          <div class="cert-name">${escapeHtml(c.student_name)}</div>
          <div class="cert-school">${escapeHtml(c.school_name || "—")}</div>
          <div class="cert-stats">${c.questions_solved} question(s) solved</div>
          <button class="btn btn-primary btn-sm cert-download-btn"
            onclick="downloadCertificateById('${c.id}')">
            ⬇️ Download PDF
          </button>
        </div>`;
    }).join("");

    const showBulkDownload = currentProfile.role === "owner";
    return `
      <div class="cert-week-block">
        <div class="cert-week-title">
          <span>📅 Week of ${new Date(weekStart).toLocaleDateString()} – ${new Date(weekEnd).toLocaleDateString()}</span>
          ${showBulkDownload ? `
            <button class="btn btn-outline btn-sm" onclick="downloadAllWeekByDate('${weekStart}')">
              Download all 3
            </button>` : ""}
        </div>
        <div class="cert-grid">${cardsHtml}</div>
      </div>`;
  }).join("");
}

window.downloadCertificateById = function (id) {
  const cert = certCache.find(c => c.id === id);
  if (!cert) return showToast("Certificate not found.", "error");
  try { drawCertificatePDF(cert); }
  catch (err) { showToast("Certificate failed: " + err.message, "error"); }
};

window.downloadAllWeekByDate = function (weekStart) {
  const certs = certCache.filter(c => c.week_start === weekStart);
  certs.forEach((c, i) => setTimeout(() => {
    try { drawCertificatePDF(c); } catch (err) { /* silent */ }
  }, i * 300));
};

function drawCertificatePDF(cert) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();

  doc.setDrawColor(15, 41, 66);
  doc.setLineWidth(3);
  doc.rect(8, 8, W - 16, H - 16);

  doc.setDrawColor(217, 119, 6);
  doc.setLineWidth(0.8);
  doc.rect(11, 11, W - 22, H - 22);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(100, 116, 139);
  doc.text("CAMBRIDGE MATH ARENA", W / 2, 28, { align: "center" });

  doc.setFontSize(26);
  doc.setTextColor(15, 41, 66);
  doc.text("Certificate of Achievement", W / 2, 48, { align: "center" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(12);
  doc.setTextColor(100, 116, 139);
  doc.text("This certificate is proudly presented to", W / 2, 72, { align: "center" });

  doc.setFont("helvetica", "bold");
  doc.setFontSize(28);
  doc.setTextColor(29, 78, 216);
  doc.text(cert.student_name, W / 2, 92, { align: "center" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(12);
  doc.setTextColor(30, 41, 59);
  doc.text(`For ranking #${cert.rank} in the weekly math challenge`, W / 2, 112, { align: "center" });

  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(217, 119, 6);
  doc.text(`${cert.questions_solved} questions solved`, W / 2, 128, { align: "center" });

  if (cert.school_name) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(100, 116, 139);
    doc.text(cert.school_name, W / 2, 142, { align: "center" });
  }

  doc.setFontSize(10);
  doc.text(
    `Week of ${new Date(cert.week_start).toLocaleDateString()} – ${new Date(cert.week_end).toLocaleDateString()}`,
    W / 2, 158, { align: "center" }
  );

  doc.setFont("helvetica", "bold");
  doc.setFontSize(48);
  doc.setTextColor(245, 158, 11);
  doc.text(`#${cert.rank}`, 32, 128);

  doc.setDrawColor(30, 41, 59);
  doc.setLineWidth(0.3);
  doc.line(W - 80, H - 32, W - 20, H - 32);
  doc.setFont("helvetica", "italic");
  doc.setFontSize(10);
  doc.setTextColor(100, 116, 139);
  doc.text("Platform Owner", W - 50, H - 27, { align: "center" });
  doc.setFont("helvetica", "normal");
  doc.text(new Date(cert.generated_at).toLocaleDateString(), W - 50, H - 22, { align: "center" });

  const safeName = cert.student_name.replace(/[^a-zA-Z0-9]/g, "-");
  doc.save(`certificate-${safeName}-rank${cert.rank}-${cert.week_start}.pdf`);
}

// ----------------------------------------------------------------------------
// Teacher dashboard exports
// ----------------------------------------------------------------------------
async function exportClassDashboardExcel() {
  if (!teacherStudentsCache.length) return showToast("No students to export.", "error");
  try {
    const rows = teacherStudentsCache.map((s, i) => ({
      Rank: i + 1,
      Student: s.full_name,
      Username: s.username || "",
      School: s.school_name || "",
      "Questions Solved": s.questions_solved,
      Score: s.score,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 6 }, { wch: 26 }, { wch: 18 }, { wch: 28 }, { wch: 16 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Class Dashboard");
    XLSX.writeFile(wb, `class-dashboard-${currentProfile.school_name || "class"}-${new Date().toISOString().slice(0, 10)}.xlsx`);
    showToast("Excel file downloaded.", "success");
  } catch (err) {
    showToast("Excel export failed: " + err.message, "error");
  }
}
async function exportClassDashboardPDF() {
  if (!teacherStudentsCache.length) return showToast("No students to export.", "error");
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.setTextColor(15, 41, 66);
    doc.text("Class Dashboard", 14, 20);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(100, 116, 139);
    doc.text(`Teacher: ${currentProfile.full_name}`, 14, 28);
    doc.text(`School: ${currentProfile.school_name || "—"}`, 14, 33);
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 38);

    const body = teacherStudentsCache.map((s, i) => [
      i + 1, s.full_name, s.username || "",
      s.school_name || "", s.questions_solved, s.score,
    ]);

    doc.autoTable({
      startY: 46,
      head: [["Rank", "Student", "Username", "School", "Solved", "Score"]],
      body,
      theme: "grid",
      headStyles: { fillColor: [15, 41, 66], textColor: 255, fontStyle: "bold" },
      styles: { fontSize: 9, cellPadding: 2 },
      columnStyles: {
        0: { cellWidth: 14 }, 1: { cellWidth: 46 }, 2: { cellWidth: 32 },
        3: { cellWidth: 44 }, 4: { cellWidth: 22 }, 5: { cellWidth: 22 },
      },
    });

    doc.save(`class-dashboard-${currentProfile.school_name || "class"}-${new Date().toISOString().slice(0, 10)}.pdf`);
    showToast("PDF downloaded.", "success");
  } catch (err) {
    showToast("PDF export failed: " + err.message, "error");
  }
}

// ============================================================================
// 1v1 STUDENT CHALLENGES
// ============================================================================
let challengeRoomInterval = null;
let challengePollInterval = null;
let challengeRealtimeChannel = null;
let cachedChallengeRow = null;
let classmateCache = [];
let summaryPollTimer = null;
let activeChallengeId = null;

// State signature tracking (prevents input re-render flicker during polling)
let lastChallengeSignature = null;
let hasAutoFocusedOwn = false;

// Presence tracking
let onlineUsersChannel = null;
let onlineUsersMap = new Map();

async function startPresenceTracking() {
  if (!currentProfile) return;
  if (onlineUsersChannel) {
    try { await onlineUsersChannel.untrack(); } catch {}
    try { await supabaseClient.removeChannel(onlineUsersChannel); } catch {}
    onlineUsersChannel = null;
  }
  onlineUsersMap = new Map();

  onlineUsersChannel = supabaseClient.channel("online-users", {
    config: { presence: { key: currentProfile.id } },
  });

  onlineUsersChannel.on("presence", { event: "sync" }, () => {
    const state = onlineUsersChannel.presenceState();
    const next = new Map();
    for (const key of Object.keys(state)) {
      const metas = state[key];
      if (metas && metas.length) {
        const m = metas[0];
        next.set(key, {
          user_id: key,
          full_name: m.full_name || "",
          role: m.role || "",
        });
      }
    }
    onlineUsersMap = next;
    const view = document.getElementById("view-challenges");
    if (view && !view.classList.contains("hidden")) renderClassmateList();
  });

  onlineUsersChannel.subscribe(async (status) => {
    if (status === "SUBSCRIBED") {
      try {
        await onlineUsersChannel.track({
          user_id: currentProfile.id,
          full_name: currentProfile.full_name,
          role: currentProfile.role,
          online_at: new Date().toISOString(),
        });
      } catch (err) {
        console.warn("Presence track failed:", err);
      }
    }
  });
}

async function stopPresenceTracking() {
  if (onlineUsersChannel) {
    try { await onlineUsersChannel.untrack(); } catch {}
    try { await supabaseClient.removeChannel(onlineUsersChannel); } catch {}
    onlineUsersChannel = null;
  }
  onlineUsersMap = new Map();
}

async function loadChallengesView() {
  await refreshChallengeSummary();

  // Every student on the platform is challengeable — not just same-class.
  const { data: allStudents } = await supabaseClient
    .from("profiles")
    .select("id, full_name, username, school_name, score, teacher_id, avatar_url")
    .eq("role", "student")
    .neq("id", currentProfile.id)
    .order("score", { ascending: false });

  classmateCache = allStudents || [];
  renderClassmateList();

  if (summaryPollTimer) clearInterval(summaryPollTimer);
  summaryPollTimer = setInterval(refreshChallengeSummary, 3000);
}

function renderClassmateList() {
  const input = document.getElementById("challenge-classmate-search");
  if (!input) return;
  const query = (input.value || "").toLowerCase();
  const filtered = classmateCache.filter(c =>
    c.full_name.toLowerCase().includes(query) ||
    (c.username || "").toLowerCase().includes(query) ||
    (c.school_name || "").toLowerCase().includes(query)
  );

  // Online first, then highest score.
  filtered.sort((a, b) => {
    const ao = onlineUsersMap.has(a.id) ? 1 : 0;
    const bo = onlineUsersMap.has(b.id) ? 1 : 0;
    if (ao !== bo) return bo - ao;
    return (b.score || 0) - (a.score || 0);
  });

  const container = document.getElementById("classmates-list");
  if (!container) return;
  if (!filtered.length) {
    container.innerHTML = `<p class="muted">No students found.</p>`;
    return;
  }

  container.innerHTML = filtered.map(c => {
    const isOnline = onlineUsersMap.has(c.id);
    const sameClass = c.teacher_id === currentProfile.teacher_id;
    const tag = sameClass
      ? `<span class="mini-tag">Your class</span>`
      : (c.school_name ? `<span class="mini-tag muted-tag">${escapeHtml(c.school_name)}</span>` : "");

    return `
      <div class="classmate-card ${isOnline ? "online" : ""}">
        ${renderAvatarHtml(c, 44, { showOnlineDot: true, isOnline })}
        <div class="classmate-info">
          <strong>${escapeHtml(c.full_name)}${isOnline ? ` <span class="online-label">• online</span>` : ""}</strong>
          <small>${escapeHtml(c.username || "")} • ${c.score} pts ${tag}</small>
        </div>
        <button class="btn btn-primary btn-sm"
                onclick="startChallenge('${c.id}')"
                title="${isOnline ? "Challenge now" : "Send challenge (they'll see it when they log in)"}">⚔️</button>
      </div>`;
  }).join("");
}

window.startChallenge = async function (opponentId) {
  if (!confirm("Send challenge invitation?")) return;
  const { error } = await supabaseClient.rpc("create_challenge", { p_opponent_id: opponentId });
  if (error) return showToast(error.message, "error");
  showToast("Challenge sent! Waiting for opponent.", "success");
  await refreshChallengeSummary();
};

async function refreshChallengeSummary() {
  const myId = currentProfile.id;

  const { data: incomingRows } = await supabaseClient
    .from("challenges")
    .select("id, challenger_id, created_at")
    .eq("opponent_id", myId)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  const { data: activeRows } = await supabaseClient
    .from("challenges")
    .select("id, challenger_id, opponent_id, round_started_at")
    .or(`challenger_id.eq.${myId},opponent_id.eq.${myId}`)
    .eq("status", "active")
    .order("round_started_at", { ascending: false });

  const { data: historyRows } = await supabaseClient
    .from("challenges")
    .select("id, status, challenger_id, opponent_id, challenger_points, opponent_points, completed_at, created_at")
    .or(`challenger_id.eq.${myId},opponent_id.eq.${myId}`)
    .in("status", ["completed", "declined", "cancelled"])
    .order("created_at", { ascending: false })
    .limit(50);

  const allIds = new Set();
  (incomingRows || []).forEach(r => allIds.add(r.challenger_id));
  (activeRows || []).forEach(r => { allIds.add(r.challenger_id); allIds.add(r.opponent_id); });
  (historyRows || []).forEach(r => { allIds.add(r.challenger_id); allIds.add(r.opponent_id); });

  let profileMap = new Map();
  if (allIds.size > 0) {
    const { data: profs } = await supabaseClient
      .from("profiles")
      .select("id, full_name, avatar_url")
      .in("id", Array.from(allIds));
    (profs || []).forEach(p => profileMap.set(p.id, p));
  }

  const incomingCard = document.getElementById("incoming-challenges-card");
  const incomingList = document.getElementById("incoming-challenges-list");
  if (incomingCard && incomingList) {
    if (incomingRows && incomingRows.length) {
      incomingCard.classList.remove("hidden");
      incomingList.innerHTML = incomingRows.map(c => `
        <div class="incoming-challenge-row">
          <div class="table-user">
            ${renderAvatarHtml(profileMap.get(c.challenger_id), 36)}
            <strong>${escapeHtml(profileMap.get(c.challenger_id)?.full_name || "Classmate")} challenges you!</strong>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-primary btn-sm" onclick="acceptChallenge('${c.id}')">✅ Accept</button>
            <button class="btn btn-outline btn-sm" onclick="declineChallenge('${c.id}')">❌ Decline</button>
          </div>
        </div>`).join("");
    } else {
      incomingCard.classList.add("hidden");
    }
  }

  const activeCard = document.getElementById("active-challenges-card");
  const activeList = document.getElementById("active-challenges-list");
  if (activeCard && activeList) {
    if (activeRows && activeRows.length) {
      activeCard.classList.remove("hidden");
      activeList.innerHTML = activeRows.map(c => {
        const opp = c.challenger_id === myId ? c.opponent_id : c.challenger_id;
        return `
          <div class="active-challenge-row">
            <div class="table-user">
              ${renderAvatarHtml(profileMap.get(opp), 36)}
              <strong>⚔️ vs ${escapeHtml(profileMap.get(opp)?.full_name || "Classmate")} — in progress</strong>
            </div>
            <button class="btn btn-primary btn-sm" onclick="openChallengeRoom('${c.id}')">🚪 Enter Room</button>
          </div>`;
      }).join("");
    } else {
      activeCard.classList.add("hidden");
    }
  }

  const tbody = document.getElementById("challenge-history-tbody");
  if (tbody) {
    if (!historyRows || !historyRows.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="muted">No past challenges yet.</td></tr>`;
    } else {
      tbody.innerHTML = historyRows.map(c => {
        const iAmChallenger = c.challenger_id === myId;
        const opp = iAmChallenger ? c.opponent_id : c.challenger_id;
        const myPts = iAmChallenger ? c.challenger_points : c.opponent_points;
        const theirPts = iAmChallenger ? c.opponent_points : c.challenger_points;
        let badge;
        if (c.status === "declined") badge = `<span class="badge badge-warning">Declined</span>`;
        else if (c.status === "cancelled") badge = `<span class="badge badge-danger">Cancelled</span>`;
        else if (myPts > theirPts) badge = `<span class="badge badge-success">🥇 Win</span>`;
        else if (theirPts > myPts) badge = `<span class="badge badge-danger">Loss</span>`;
        else badge = `<span class="badge badge-warning">Draw</span>`;
        return `
          <tr>
            <td>${fmtDate(c.created_at)}</td>
            <td>
              <div class="table-user">
                ${renderAvatarHtml(profileMap.get(opp), 28)}
                <span>${escapeHtml(profileMap.get(opp)?.full_name || "—")}</span>
              </div>
            </td>
            <td><strong>${myPts}</strong></td>
            <td>${theirPts}</td>
            <td>${badge}</td>
          </tr>`;
      }).join("");
    }
  }
}

window.acceptChallenge = async function (challengeId) {
  const { error } = await supabaseClient.rpc("accept_challenge", { p_challenge_id: challengeId });
  if (error) return showToast(error.message, "error");
  showToast("Challenge accepted! Starting…", "success");
  await openChallengeRoom(challengeId);
};

window.declineChallenge = async function (challengeId) {
  if (!confirm("Decline this challenge?")) return;
  const { error } = await supabaseClient.rpc("decline_challenge", { p_challenge_id: challengeId });
  if (error) return showToast(error.message, "error");
  showToast("Challenge declined.", "info");
  await refreshChallengeSummary();
};

// ----------------------------------------------------------------------------
// Challenge room
// ----------------------------------------------------------------------------
window.openChallengeRoom = async function (challengeId) {
  activeChallengeId = challengeId;
  lastChallengeSignature = null;
  hasAutoFocusedOwn = false;
  document.getElementById("challenge-room-modal").classList.remove("hidden");
  await refreshChallengeRoom();
  if (challengeRoomInterval) clearInterval(challengeRoomInterval);
  challengeRoomInterval = setInterval(tickChallengeTimer, 100);

  if (challengeRealtimeChannel) await supabaseClient.removeChannel(challengeRealtimeChannel);
  challengeRealtimeChannel = supabaseClient
    .channel(`challenge-${challengeId}`)
    .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "challenges", filter: `id=eq.${challengeId}` },
      () => refreshChallengeRoom())
    .subscribe();

  if (challengePollInterval) clearInterval(challengePollInterval);
  challengePollInterval = setInterval(refreshChallengeRoom, 2000);
};

window.closeChallengeRoom = async function () {
  document.getElementById("challenge-room-modal").classList.add("hidden");
  if (challengeRoomInterval) { clearInterval(challengeRoomInterval); challengeRoomInterval = null; }
  if (challengePollInterval) { clearInterval(challengePollInterval); challengePollInterval = null; }
  if (challengeRealtimeChannel) {
    await supabaseClient.removeChannel(challengeRealtimeChannel);
    challengeRealtimeChannel = null;
  }
  activeChallengeId = null;
  cachedChallengeRow = null;
  lastChallengeSignature = null;
  hasAutoFocusedOwn = false;
  await refreshChallengeSummary();
};

async function refreshChallengeRoom() {
  if (!activeChallengeId) return;
  const myId = currentProfile.id;

  const { data: row, error } = await supabaseClient
    .from("challenges").select("*").eq("id", activeChallengeId).single();
  if (error || !row) return;
  cachedChallengeRow = row;

  const isChallenger = row.challenger_id === myId;
  const myQId  = isChallenger ? row.challenger_question_id : row.opponent_question_id;
  const oppQId = isChallenger ? row.opponent_question_id   : row.challenger_question_id;
  const myResult      = isChallenger ? row.challenger_result       : row.opponent_result;
  const oppResult     = isChallenger ? row.opponent_result         : row.challenger_result;
  const myStealResult = isChallenger ? row.challenger_steal_result : row.opponent_steal_result;
  const myPoints      = isChallenger ? row.challenger_points       : row.opponent_points;
  const oppPoints     = isChallenger ? row.opponent_points         : row.challenger_points;

  const signature = JSON.stringify({
    status: row.status,
    myResult, oppResult, myStealResult,
    myPoints, oppPoints,
    winner: row.winner_id,
    myQId, oppQId,
  });
  if (signature === lastChallengeSignature) return;
  lastChallengeSignature = signature;

  const prevOwnInputs  = Array.from(document.querySelectorAll('#challenge-my-question .challenge-answer-slot'));
  const prevOwnValues  = prevOwnInputs.map(i => i.value);
  const prevOwnFocusIdx = (() => {
    const a = document.activeElement;
    return a && a.classList.contains('challenge-answer-slot') ? parseInt(a.dataset.index) : -1;
  })();
  const prevStealInputs = Array.from(document.querySelectorAll('#challenge-steal-question .challenge-steal-answer-slot'));
  const prevStealValues = prevStealInputs.map(i => i.value);
  const prevStealFocusIdx = (() => {
    const a = document.activeElement;
    return a && a.classList.contains('challenge-steal-answer-slot') ? parseInt(a.dataset.index) : -1;
  })();

  const { data: profs } = await supabaseClient
    .from("profiles").select("id, full_name, avatar_url")
    .in("id", [row.challenger_id, row.opponent_id]);
  const profileMap = new Map((profs || []).map(p => [p.id, p]));

  const qIds = [myQId, oppQId].filter(Boolean);
  let qMap = new Map();
  let slotMap = new Map();
  if (qIds.length) {
    const [qsRes, slotRes] = await Promise.all([
      supabaseClient.from("questions")
        .select("id, title, image_url, points").in("id", qIds),
      supabaseClient.rpc("get_slot_counts_for_questions", { p_question_ids: qIds }),
    ]);
    (qsRes.data || []).forEach(q => qMap.set(q.id, q));
    (slotRes.data || []).forEach(r => slotMap.set(r.question_id, Number(r.slot_count) || 0));
  }

  const myQ  = qMap.get(myQId);
  const oppQ = qMap.get(oppQId);
  const mySlots  = slotMap.get(myQId)  ?? 0;
  const oppSlots = slotMap.get(oppQId) ?? 0;
  const oppId = isChallenger ? row.opponent_id : row.challenger_id;
  const oppProfile = profileMap.get(oppId);

  // Scoreboard
  document.getElementById("challenger-name").textContent = "You";
  document.getElementById("challenger-points").textContent = `${myPoints} pts`;
  document.getElementById("opponent-name").textContent = oppProfile?.full_name || "Opponent";
  document.getElementById("opponent-points").textContent = `${oppPoints} pts`;
  const ca = document.getElementById("challenger-avatar");
  if (ca) ca.innerHTML = renderAvatarHtml(currentProfile, 48);
  const oa = document.getElementById("opponent-avatar");
  if (oa) oa.innerHTML = renderAvatarHtml(oppProfile || { full_name: "?" }, 48);

  // My question area
  const qArea = document.getElementById("challenge-my-question");
  if (row.status !== "active") {
    qArea.innerHTML = `<p class="muted">Challenge not active.</p>`;
  } else if (myResult) {
    let badge;
    if (myResult === "correct") badge = `<span class="badge badge-success">✅ Correct (+${myQ?.points || 0} pts)</span>`;
    else if (myResult === "wrong") badge = `<span class="badge badge-danger">❌ Wrong</span>`;
    else badge = `<span class="badge badge-warning">⏱️ Timeout</span>`;
    qArea.innerHTML = `<p>${badge}</p>`;
  } else if (myQ) {
    const slots = mySlots > 0 ? mySlots : 1;
    let inputsHtml = "";
    for (let i = 0; i < slots; i++) {
      inputsHtml += `
        <label class="answer-slot-label">Answer #${i + 1}</label>
        <input type="text" class="answer-slot challenge-answer-slot" data-index="${i}"
               placeholder="Answer ${i + 1}" required autocomplete="off" />`;
    }
    qArea.innerHTML = `
      <div class="question-meta" style="margin-bottom:0.5rem;">
        <span class="stage-tag">${escapeHtml(myQ.title)}</span>
        <span class="points-tag">+${myQ.points} pts</span>
        ${slots > 1 ? `<span class="stage-tag">${slots} answers</span>` : ""}
      </div>
      <img class="challenge-question-img" src="${escapeHtml(myQ.image_url)}"
           onclick="openImageZoom('${escapeHtml(myQ.image_url)}')" />
      <form class="challenge-answer-form" onsubmit="submitChallengeOwnAnswer(event)">
        <div style="display:flex;flex-direction:column;gap:0.5rem;width:100%;">
          ${inputsHtml}
          <button type="submit">Submit</button>
        </div>
      </form>`;

    const newInputs = qArea.querySelectorAll(".challenge-answer-slot");
    newInputs.forEach((inp, i) => {
      if (prevOwnValues[i] !== undefined) inp.value = prevOwnValues[i];
    });
    if (prevOwnFocusIdx >= 0 && newInputs[prevOwnFocusIdx]) {
      newInputs[prevOwnFocusIdx].focus();
    } else if (!hasAutoFocusedOwn && newInputs[0]) {
      setTimeout(() => newInputs[0]?.focus(), 80);
      hasAutoFocusedOwn = true;
    }
  } else {
    qArea.innerHTML = `<p class="muted">No question assigned.</p>`;
  }

  // Steal area
  const stealArea = document.getElementById("challenge-steal-area");
  const stealQArea = document.getElementById("challenge-steal-question");
  const canSteal = oppResult && oppResult !== "correct" && !myStealResult
                   && row.status === "active" && myResult;
  if (canSteal && oppQ) {
    stealArea.classList.remove("hidden");
    document.getElementById("challenge-steal-desc").textContent =
      `${oppProfile?.full_name || "Opponent"} missed their question. Solve it to steal +${oppQ.points} points!`;
    const slots = oppSlots > 0 ? oppSlots : 1;
    let inputsHtml = "";
    for (let i = 0; i < slots; i++) {
      inputsHtml += `
        <label class="answer-slot-label">Answer #${i + 1}</label>
        <input type="text" class="answer-slot challenge-steal-answer-slot" data-index="${i}"
               placeholder="Answer ${i + 1}" required autocomplete="off" />`;
    }
    stealQArea.innerHTML = `
      <div class="question-meta" style="margin-bottom:0.5rem;">
        <span class="stage-tag">${escapeHtml(oppQ.title)}</span>
        <span class="points-tag">+${oppQ.points} pts</span>
        ${slots > 1 ? `<span class="stage-tag">${slots} answers</span>` : ""}
      </div>
      <img class="challenge-question-img" src="${escapeHtml(oppQ.image_url)}"
           onclick="openImageZoom('${escapeHtml(oppQ.image_url)}')" />
      <form class="challenge-answer-form" onsubmit="submitChallengeStealAnswer(event)">
        <div style="display:flex;flex-direction:column;gap:0.5rem;width:100%;">
          ${inputsHtml}
          <button type="submit">⚡ Steal</button>
        </div>
      </form>`;

    const newInputs = stealQArea.querySelectorAll(".challenge-steal-answer-slot");
    newInputs.forEach((inp, i) => {
      if (prevStealValues[i] !== undefined) inp.value = prevStealValues[i];
    });
    if (prevStealFocusIdx >= 0 && newInputs[prevStealFocusIdx]) {
      newInputs[prevStealFocusIdx].focus();
    }
  } else {
    stealArea.classList.add("hidden");
  }

  // Result banner
  const resultBanner = document.getElementById("challenge-result-banner");
  if (row.status === "completed") {
    resultBanner.classList.remove("hidden", "win", "loss", "draw");
    if (row.winner_id === myId) {
      resultBanner.classList.add("win");
      resultBanner.textContent = `🏆 You won! ${myPoints} vs ${oppPoints}`;
    } else if (!row.winner_id) {
      resultBanner.classList.add("draw");
      resultBanner.textContent = `🤝 Draw — ${myPoints} vs ${oppPoints}`;
    } else {
      resultBanner.classList.add("loss");
      resultBanner.textContent = `❌ You lost — ${myPoints} vs ${oppPoints}`;
    }
  } else {
    resultBanner.classList.add("hidden");
  }

  // Auto-finalize
  if (row.status === "active") {
    const bothOwnDone = row.challenger_result && row.opponent_result;
    const chDone = row.challenger_result === "correct" || row.challenger_steal_result;
    const opDone = row.opponent_result === "correct" || row.opponent_steal_result;
    if (bothOwnDone && chDone && opDone) {
      await supabaseClient.rpc("finalize_challenge", { p_challenge_id: activeChallengeId });
    }
  }
}

function tickChallengeTimer() {
  if (!cachedChallengeRow || cachedChallengeRow.status !== "active") return;
  const startedMs = new Date(cachedChallengeRow.round_started_at).getTime();
  const durationMs = (cachedChallengeRow.round_duration_sec || 120) * 1000;
  const remaining = Math.max(0, durationMs - (Date.now() - startedMs));

  const el = document.getElementById("challenge-timer-display");
  if (!el) return;
  const totalSec = Math.floor(remaining / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const tenths = Math.floor((remaining % 1000) / 100);
  el.textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${tenths}`;
  el.classList.toggle("urgent", remaining <= 10000 && remaining > 0);

  const myId = currentProfile.id;
  const isMeChallenger = cachedChallengeRow.challenger_id === myId;

  if (remaining === 0) {
    const myResult = isMeChallenger ? cachedChallengeRow.challenger_result : cachedChallengeRow.opponent_result;
    const oppResult = isMeChallenger ? cachedChallengeRow.opponent_result : cachedChallengeRow.challenger_result;
    const mySide = isMeChallenger ? "challenger" : "opponent";
    const oppSide = isMeChallenger ? "opponent" : "challenger";

    if (!myResult) {
      supabaseClient.rpc("timeout_challenge_side", {
        p_challenge_id: activeChallengeId, p_side: mySide,
      }).then(() => refreshChallengeRoom());
    }
    if (Date.now() - startedMs >= 125000 && !oppResult) {
      supabaseClient.rpc("timeout_challenge_side", {
        p_challenge_id: activeChallengeId, p_side: oppSide,
      }).then(() => refreshChallengeRoom());
    }
  }
}

window.submitChallengeOwnAnswer = async function (e) {
  e.preventDefault();
  const inputs = Array.from(document.querySelectorAll("#challenge-my-question .challenge-answer-slot"));
  const answers = inputs.map(i => i.value.trim());
  if (answers.some(a => !a)) return showToast("Fill in every answer box.", "error");
  const payload = JSON.stringify(answers);
  const { data, error } = await supabaseClient.rpc("submit_challenge_own_answer", {
    p_challenge_id: activeChallengeId, p_answer: payload,
  });
  if (error) return showToast(error.message, "error");
  if (data.is_correct) {
    showToast(`✅ Correct! +${data.points_awarded} points`, "success");
    currentProfile.score = data.new_score;
    currentProfile.questions_solved = data.questions_solved;
    document.getElementById("header-score-badge").textContent = `${data.new_score} pts`;
  } else {
    showToast("❌ Wrong — your opponent may steal.", "error");
  }
  lastChallengeSignature = null;
  await refreshChallengeRoom();
};

window.submitChallengeStealAnswer = async function (e) {
  e.preventDefault();
  const inputs = Array.from(document.querySelectorAll("#challenge-steal-question .challenge-steal-answer-slot"));
  const answers = inputs.map(i => i.value.trim());
  if (answers.some(a => !a)) return showToast("Fill in every steal answer box.", "error");
  const payload = JSON.stringify(answers);
  const { data, error } = await supabaseClient.rpc("submit_challenge_steal_answer", {
    p_challenge_id: activeChallengeId, p_answer: payload,
  });
  if (error) return showToast(error.message, "error");
  if (data.is_correct) {
    showToast(`⚡ STOLEN! +${data.points_awarded} points`, "success");
    currentProfile.score = data.new_score;
    document.getElementById("header-score-badge").textContent = `${data.new_score} pts`;
  } else {
    showToast("❌ Steal failed.", "error");
  }
  lastChallengeSignature = null;
  await refreshChallengeRoom();
};
