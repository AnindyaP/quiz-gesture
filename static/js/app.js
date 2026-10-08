/*GESTURE QUIZ AI — Frontend v5
   Perubahan dari v4:
   [TTS-1] Web Speech API — baca soal otomatis saat QUESTION dimulai
   [TTS-2] Panel kontrol TTS: mute, kecepatan, pilih suara, baca pilihan
   [TTS-3] Indikator visual saat TTS sedang berjalan
   [TTS-4] Cancel otomatis saat pindah soal / reset / close
   [TTS-5] Fallback graceful jika browser tidak support TTS
   ═══════════════════════════════════════════════════════════ */
'use strict';

let state        = {};
let questions    = [];
let settings     = {};
let sseSource    = null;
let sessionStart = null;
let pollInterval = null;
let editingQId   = null;
let optionCount  = 0;
let sseRetryMs   = 500;
let rafHandle    = null;
let livePageActive = false;
let quizEndShown   = false;
let sidebarCollapsed = false;
let lastCountdownVal = -1;
let answerPopupTimer = null;

const TEAM_COLORS = ['#f97316','#3b82f6','#10b981','#e11d48'];
const ANS_LABELS  = {1:'A',2:'B',3:'C',4:'D',5:'E'};

const dirty = {
  scores:true, question:true, gesture:true, analytics:true,
  liveQ:true, liveTeams:true, override:true, chart:true,
};
function markDirty(...keys) { keys.forEach(k => dirty[k] = true); }
function clearDirty(k)      { dirty[k] = false; }
const _prev = {};

// ══════════════════════════════════════════════════════════
//  WEB AUDIO ENGINE — tanpa file eksternal
// ══════════════════════════════════════════════════════════
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let _actx = null;
// Audio file eksternal
const applauseAudio = new Audio('/static/audio/applause.mp3');

// Optional setting
applauseAudio.volume = 0.9;
function getAudioCtx() {
  if (!_actx) { try { _actx = new AudioCtx(); } catch(e) {} }
  return _actx;
}
function playTone(freq=440, dur=0.15, type='sine', vol=0.4, delay=0) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type      = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
  gain.gain.setValueAtTime(0, ctx.currentTime + delay);
  gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + delay + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + dur);
  osc.start(ctx.currentTime + delay);
  osc.stop(ctx.currentTime + delay + dur + 0.05);
}
function soundCountdownTick(num) {
  if (num === 0) {
    playTone(523, 0.12, 'sine', 0.5, 0);
    playTone(659, 0.12, 'sine', 0.5, 0.13);
    playTone(784, 0.18, 'sine', 0.6, 0.26);
  } else {
    const freqs = {3:660, 2:590, 1:520};
    playTone(freqs[num] || 550, 0.18, 'sine', 0.45);
  }
}
function soundCorrect() {
  playTone(523, 0.12, 'sine', 0.45, 0);
  playTone(659, 0.12, 'sine', 0.45, 0.12);
  playTone(784, 0.22, 'sine', 0.55, 0.24);
}
function soundWrong() {
  playTone(300, 0.14, 'square', 0.35, 0);
  playTone(220, 0.22, 'square', 0.3, 0.15);
}
function soundMixed() {
  playTone(600, 0.12, 'sine', 0.4, 0);
  playTone(380, 0.18, 'triangle', 0.3, 0.14);
}
function soundLock() {
  playTone(880, 0.07, 'sine', 0.35);
  playTone(1100, 0.1, 'sine', 0.25, 0.08);
}
function soundVictory() {

  // Nada kemenangan meriah

  playTone(523, 0.18, 'sine', 0.45, 0);     // C
  playTone(659, 0.18, 'sine', 0.45, 0.2);   // E
  playTone(784, 0.22, 'sine', 0.5, 0.4);    // G
  playTone(1046,0.35, 'sine', 0.6, 0.65);   // C tinggi

  // Tambahan sparkle
  playTone(1568,0.12, 'triangle', 0.2, 1.0);
  playTone(2093,0.18, 'triangle', 0.18,1.15);
}
function soundClap() {

  // Reset agar bisa diputar ulang
  applauseAudio.currentTime = 0;

  // Play applause
  applauseAudio.play()
    .catch(err => {
      console.warn('Audio applause gagal diputar:', err);
    });
}

// ══════════════════════════════════════════════════════════
//  TTS ENGINE — Web Speech API
// ══════════════════════════════════════════════════════════

const TTS = {
  // State internal
  _supported:  typeof window !== 'undefined' && 'speechSynthesis' in window,
  _muted:      false,
  _rate:       1.0,
  _voice:      null,       // SpeechSynthesisVoice yang dipilih
  _voiceList:  [],
  _speaking:   false,
  _readOptions: true,      // baca pilihan A/B/C/D juga
  _lastQIndex: -1,         // track soal terakhir yang dibacakan
  _utterance:  null,       // utterance aktif

  // ── Init: muat voices & restore preferensi ──────────────
  init() {
    if (!this._supported) return;

    // Restore preferensi dari sessionStorage
    try {
      const prefs = JSON.parse(sessionStorage.getItem('tts_prefs') || '{}');
      this._muted      = prefs.muted      ?? false;
      this._rate       = prefs.rate       ?? 1.0;
      this._readOptions = prefs.readOptions ?? true;
    } catch(e) {}

    // Muat daftar suara — bisa async di beberapa browser
    const loadVoices = () => {
      this._voiceList = window.speechSynthesis.getVoices();
      this._selectDefaultVoice();
      this._populateVoiceSelect();
    };
    loadVoices();
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }

    this._updateUI();
  },

  // ── Pilih suara default: prioritaskan id-ID, lalu id, lalu default ──
  _selectDefaultVoice() {
    if (!this._voiceList.length) return;

    // Coba suara tersimpan dulu
    const savedName = sessionStorage.getItem('tts_voice_name');
    if (savedName) {
      const saved = this._voiceList.find(v => v.name === savedName);
      if (saved) { this._voice = saved; return; }
    }

    // Prioritas: id-ID > id > default browser
    const idID   = this._voiceList.find(v => v.lang === 'id-ID');
    const idLang = this._voiceList.find(v => v.lang.startsWith('id'));
    const defV   = this._voiceList.find(v => v.default);
    this._voice  = idID || idLang || defV || this._voiceList[0] || null;
  },

  // ── Isi <select> suara di panel TTS ──────────────────────
  _populateVoiceSelect() {
    const sel = document.getElementById('tts-voice-select');
    if (!sel) return;
    sel.innerHTML = this._voiceList.map(v =>
      `<option value="${escAttr(v.name)}" ${v === this._voice ? 'selected' : ''}>
        ${escHtml(v.name)} (${v.lang})
      </option>`
    ).join('');
  },

  // ── Update UI controls sesuai state ─────────────────────
  _updateUI() {
    // Tombol mute
    const muteBtn = document.getElementById('tts-mute-btn');
    if (muteBtn) {
      muteBtn.innerHTML = this._muted
        ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
             <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
             <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
           </svg> Suara Mati`
        : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
             <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
             <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>
           </svg> Suara Nyala`;
      muteBtn.classList.toggle('muted', this._muted);
    }

    // Slider kecepatan
    const rateSlider = document.getElementById('tts-rate-slider');
    const rateLabel  = document.getElementById('tts-rate-val');
    if (rateSlider) rateSlider.value = this._rate;
    if (rateLabel)  rateLabel.textContent = `${this._rate}×`;

    // Toggle baca pilihan
    const optToggle = document.getElementById('tts-read-options');
    if (optToggle) optToggle.checked = this._readOptions;

    // Indikator speaking
    this._updateSpeakingIndicator();
  },

  _updateSpeakingIndicator() {
    const ind = document.getElementById('tts-speaking-indicator');
    if (!ind) return;
    if (this._speaking && !this._muted) {
      ind.classList.add('active');
      ind.title = 'TTS sedang berjalan...';
    } else {
      ind.classList.remove('active');
      ind.title = 'TTS tidak aktif';
    }
  },

  // ── Simpan preferensi ────────────────────────────────────
  _savePrefs() {
    try {
      sessionStorage.setItem('tts_prefs', JSON.stringify({
        muted: this._muted, rate: this._rate, readOptions: this._readOptions,
      }));
      if (this._voice) sessionStorage.setItem('tts_voice_name', this._voice.name);
    } catch(e) {}
  },

  // ── Hentikan ucapan yang sedang berjalan ─────────────────
  cancel() {
    if (!this._supported) return;
    window.speechSynthesis.cancel();
    this._speaking = false;
    this._utterance = null;
    this._updateSpeakingIndicator();
  },

  // ── Ucapkan teks — publik ────────────────────────────────
  speak(text, onEnd) {
    if (!this._supported || this._muted || !text) return;

    // Cancel dulu kalau masih ada yang berjalan
    this.cancel();

    const utt = new SpeechSynthesisUtterance(text);
    utt.lang  = this._voice?.lang || 'id-ID';
    utt.rate  = this._rate;
    utt.pitch = 1.0;
    utt.volume = 0.95;
    if (this._voice) utt.voice = this._voice;

    utt.onstart = () => {
      this._speaking = true;
      this._updateSpeakingIndicator();
    };
    utt.onend = () => {
      this._speaking = false;
      this._utterance = null;
      this._updateSpeakingIndicator();
      if (onEnd) onEnd();
    };
    utt.onerror = (e) => {
      // 'interrupted' adalah normal saat cancel dipanggil
      if (e.error !== 'interrupted') console.warn('[TTS] Error:', e.error);
      this._speaking = false;
      this._utterance = null;
      this._updateSpeakingIndicator();
    };

    this._utterance = utt;

    // Workaround bug Chrome: speechSynthesis berhenti setelah ~15 detik
    // jika halaman tidak di-focus. Kita resume setiap 10 detik.
    const chromeFix = setInterval(() => {
      if (this._speaking && window.speechSynthesis.speaking) {
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      } else {
        clearInterval(chromeFix);
      }
    }, 10000);

    window.speechSynthesis.speak(utt);
  },

  // ── Baca soal + pilihan (dipanggil saat QUESTION_START) ──
  readQuestion(question, qIndex) {
    if (!question) return;

    // Hindari baca soal yang sama dua kali
    if (qIndex !== undefined && qIndex === this._lastQIndex) return;
    this._lastQIndex = qIndex ?? -1;

    const num    = qIndex !== undefined ? `Soal nomor ${qIndex + 1}. ` : '';
    const soal   = question.soal || '';
    let fullText = `${num}${soal}`;

    if (this._readOptions && question.pilihan?.length) {
      const labels = ['A', 'B', 'C', 'D', 'E'];
      const opts   = question.pilihan
        .map((opt, i) => `${labels[i]}: ${opt}`)
        .join('. ');
      fullText += `. Pilihan jawaban: ${opts}.`;
    }

    this.speak(fullText);
  },

  // ── Baca pengumuman hasil (benar / salah / dll) ──────────
  readResult(allCorrect, allWrong) {
    if (allCorrect)     this.speak('Semua tim menjawab dengan benar!');
    else if (allWrong)  this.speak('Semua tim menjawab salah.');
    else                this.speak('Ada yang benar, ada yang salah.');
  },

  // ── Toggle mute ─────────────────────────────────────────
  toggleMute() {
    this._muted = !this._muted;
    if (this._muted) this.cancel();
    this._savePrefs();
    this._updateUI();
    toast(this._muted ? '🔇 Suara dimatikan' : '🔊 Suara dinyalakan', 'warning');
  },

  // ── Set kecepatan (dari slider) ──────────────────────────
  setRate(val) {
    this._rate = parseFloat(val);
    const rateLabel = document.getElementById('tts-rate-val');
    if (rateLabel) rateLabel.textContent = `${this._rate}×`;
    this._savePrefs();
  },

  // ── Set suara (dari <select>) ────────────────────────────
  setVoice(name) {
    this._voice = this._voiceList.find(v => v.name === name) || this._voice;
    this._savePrefs();
  },

  // ── Toggle baca pilihan ──────────────────────────────────
  toggleReadOptions(val) {
    this._readOptions = !!val;
    this._savePrefs();
  },

  // ── Tes suara dari UI ────────────────────────────────────
  test() {
    this.cancel();
    const tmp = this._muted;
    this._muted = false;
    this.speak('Ini adalah tes suara. Bahasa Indonesia. Gesture Quiz.', () => {
      this._muted = tmp;
    });
  },
};

// ══════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initSSE();
  loadQuestions();
  loadSettings();
  initSidebarToggle();
  initSliders();
  initImportHidden();
  startRenderLoop();
  TTS.init();

  // Klik overlay popup jawaban = dismiss
  document.getElementById('answer-popup-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'answer-popup-overlay' || e.target.closest('#answer-popup')) {
      closeAnswerPopup();
    }
  });

  // Tombol di quiz-end overlay
  document.querySelector('.qeo-actions')?.addEventListener('click', e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'analytics') { closeQuizEnd(); showPage('analytics'); }
    if (action === 'reset')     { closeQuizEnd(); resetSession(); }
    if (action === 'close')     { closeQuizEnd(); }
  });

  // TTS controls — event delegation untuk panel yang di-render dinamis
  document.addEventListener('click', e => {
    if (e.target.closest('#tts-mute-btn'))   TTS.toggleMute();
    if (e.target.closest('#tts-test-btn'))   TTS.test();
  });
  document.addEventListener('input', e => {
    if (e.target.id === 'tts-rate-slider')   TTS.setRate(e.target.value);
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'tts-voice-select')  TTS.setVoice(e.target.value);
    if (e.target.id === 'tts-read-options')  TTS.toggleReadOptions(e.target.checked);
  });
});

// ══════════════════════════════════════════════════════════
//  NAVIGATION
// ══════════════════════════════════════════════════════════
function initNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      const page = item.dataset.page;
      if (page) showPage(page);
    });
  });
}

function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const page = document.getElementById(`page-${pageId}`);
  const nav  = document.querySelector(`.nav-item[data-page="${pageId}"]`);
  if (page) page.classList.add('active');
  if (nav)  nav.classList.add('active');
  document.getElementById('page-title').textContent = {
    dashboard:'Dashboard', live:'Live Game', questions:'Bank Soal',
    teams:'Manajemen Tim', settings:'Pengaturan', analytics:'Analitik Detail',
  }[pageId] || pageId;
  livePageActive = pageId === 'live';
  toggleVideoFeed(livePageActive);
  if (pageId === 'teams')     renderTeamPage();
  if (pageId === 'analytics') loadAnalytics();
  if (pageId === 'questions') renderQuestions();
  if (pageId === 'live') { markDirty('liveQ','liveTeams','override'); renderLivePage(); }
  if (pageId === 'settings')  populateSettings();
}

function toggleVideoFeed(active) {
  const img = document.getElementById('video-feed');
  if (!img) return;
  if (active) {
    if (!img.src || !img.src.includes('/api/video')) img.src = '/api/video';
  } else {
    img.src = '';
  }
}

function initSidebarToggle() {
  const toggle   = document.getElementById('sidebar-toggle');
  const sidebar  = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');

  toggle?.addEventListener('click', () => {
    const isMobile = window.innerWidth <= 800;
    if (isMobile) {
      sidebar.classList.toggle('mobile-open');
      const isOpen = sidebar.classList.contains('mobile-open');
      if (backdrop) backdrop.style.display = isOpen ? 'block' : 'none';
    } else {
      sidebarCollapsed = !sidebarCollapsed;
      sidebar.classList.toggle('collapsed', sidebarCollapsed);
    }
  });

  backdrop?.addEventListener('click', () => {
    sidebar.classList.remove('mobile-open');
    if (backdrop) backdrop.style.display = 'none';
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 800) {
      sidebar.classList.remove('mobile-open');
      if (backdrop) backdrop.style.display = 'none';
      sidebar.classList.toggle('collapsed', sidebarCollapsed);
    }
  });
}

// ══════════════════════════════════════════════════════════
//  SSE
// ══════════════════════════════════════════════════════════
function initSSE() {
  if (sseSource) { sseSource.close(); sseSource = null; }
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  sseSource = new EventSource('/api/stream');
  sseSource.onopen = () => {
    setServerStatus(true); sseRetryMs = 500;
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  };
  sseSource.onmessage = (e) => {
    try {
      const payload = JSON.parse(e.data);
      handleStateUpdate(payload.state);
      handleEvents(payload.events || []);
    } catch(err) { console.error('SSE parse error', err); }
  };
  sseSource.onerror = () => {
    setServerStatus(false); sseSource.close(); sseSource = null;
    if (!pollInterval) pollInterval = setInterval(pollState, 1500);
    setTimeout(() => { sseRetryMs = Math.min(sseRetryMs * 2, 10000); initSSE(); }, sseRetryMs);
  };
}

function setServerStatus(online) {
  document.getElementById('server-status')?.classList.toggle('offline', !online);
}

async function pollState() {
  try {
    const r = await fetch('/api/state');
    if (r.ok) { handleStateUpdate(await r.json()); setServerStatus(true); }
  } catch(e) { setServerStatus(false); }
}

// ══════════════════════════════════════════════════════════
//  STATE HANDLING
// ══════════════════════════════════════════════════════════
function handleStateUpdate(newState) {
  const prevGameState = state.state;
  state = newState;

  // Reset countdown tracker
  if (prevGameState === 'COUNTDOWN' && newState.state !== 'COUNTDOWN') {
    _cdTrackTs = 0;
    lastCountdownVal = -1;
    hideCountdownPopup();
  }
  if (prevGameState !== 'COUNTDOWN' && newState.state === 'COUNTDOWN') {
    _cdTrackTs = Date.now();
    lastCountdownVal = -1;
  }

  setTextIfChanged('sidebar-state', state.state || 'IDLE');
  setTextIfChanged('sidebar-detail',
    state.session_id ? `Sesi: ${state.session_id}` : 'Belum ada sesi aktif');
  document.getElementById('cam-status')?.classList.toggle('offline', !state.camera_active);

  const badge = document.getElementById('state-badge');
  if (badge && badge.textContent !== (state.state||'IDLE')) {
    badge.textContent = state.state || 'IDLE';
    badge.className   = `state-badge ${state.state||''}`;
  }

  const total = state.total_q || 0;
  const done  = Math.max(0, ['IDLE','DASHBOARD'].includes(state.state)
    ? (state.stats?.length||0) : (state.q_index||0));
  const pct   = total > 0 ? (done/total*100) : 0;
  setTextIfChanged('q-progress-text', `${done} / ${total}`);
  const pf = document.getElementById('q-progress-fill');
  if (pf) { const v=`${pct.toFixed(1)}%`; if(pf.style.width!==v) pf.style.width=v; }

  const scoresKey = JSON.stringify(state.scores);
  if (scoresKey !== _prev.scores) { _prev.scores = scoresKey; markDirty('scores','analytics','chart'); }
  const qKey = `${state.q_index}:${state.state}:${state.question?.soal}`;
  if (qKey !== _prev.question) { _prev.question = qKey; markDirty('question','liveQ'); }
  const gKey = JSON.stringify(
    Object.entries(state.gesture||{}).map(([t,g])=>[t,g.fingers,g.locked,g.answer]));
  if (gKey !== _prev.gesture) { _prev.gesture = gKey; markDirty('gesture','liveTeams','override'); }
  const statsKey = state.stats?.length;
  if (statsKey !== _prev.statsLen) { _prev.statsLen = statsKey; markDirty('chart','analytics'); }

  if (dirty.scores)    { renderScoreCards();      clearDirty('scores');    }
  if (dirty.question)  { renderCurrentQuestion(); clearDirty('question');  }
  if (dirty.gesture)   { renderGestureGrid();     clearDirty('gesture');   }
  if (dirty.analytics) { updateAnalyticsMini();   clearDirty('analytics'); }
  if (dirty.chart)     { renderTeamBarChart();    clearDirty('chart');     }

  if (livePageActive) {
    if (dirty.liveQ)     { renderLiveQuestion();  clearDirty('liveQ');    }
    if (dirty.liveTeams) { renderLiveTeams();     clearDirty('liveTeams');}
    if (dirty.override)  { updateOverrideBtns();  clearDirty('override'); }
    updateVideoOverlay();
  }
  if (document.getElementById('page-teams')?.classList.contains('active')) renderLeaderboard();

  const btn = document.getElementById('btn-quick-start');
  if (btn) {
    const inSession = !['IDLE','DASHBOARD'].includes(state.state);
    const txt = inSession ? '■ Stop' : '▶ Mulai Kuis';
    if (btn.textContent !== txt) { btn.textContent = txt; btn.onclick = inSession ? resetSession : quickStart; }
  }
}

function handleEvents(events) {
  events.forEach(ev => {
    switch(ev.type) {

      case 'ANSWER_LOCKED':
        toast(`${getTeamName(ev.data.team)} mengunci: ${ANS_LABELS[ev.data.answer]||'?'}`, 'success');
        soundLock();
        break;

      case 'RESULT':
      case 'RESULT_BATCH': {
        // Cancel TTS soal, siap baca hasil
        TTS.cancel();
        const teams     = Object.keys(state.teams || {});
        const allRight  = teams.every(t => ev.data.result?.[t]);
        const allWrong  = teams.every(t => !ev.data.result?.[t]);
        showResultFlash(ev.data.result);
        showAnswerPopup(ev.data.result, ev.data.scores);
        if (allRight)       soundCorrect();
        else if (allWrong)  soundWrong();
        else                soundMixed();
        // Baca pengumuman hasil (setelah efek suara selesai)
        setTimeout(() => TTS.readResult(allRight, allWrong), 500);
        markDirty('scores','question','gesture','liveQ','liveTeams','override','analytics','chart');
        break;
      }

      case 'QUESTION_START':
      case 'QUESTION_NEXT':
        // Cancel apapun yang sedang dibacakan, lalu baca soal baru
        TTS.cancel();
        TTS._lastQIndex = -1; // reset agar soal baru pasti dibaca
        markDirty('question','gesture','liveQ','liveTeams','override','chart');
        lastCountdownVal = -1;
        // Baca soal — dilakukan dengan sedikit delay agar state ter-update dulu
        setTimeout(() => {

        // Pastikan state masih QUESTION
        if (state.state === 'QUESTION' && state.question) {
          // Baru baca soal
          setTimeout(() => {
            TTS.readQuestion(state.question, state.q_index);
          }, 250);
        }

      }, 4000); // tunggu countdown selesai

      break;


      case 'SESSION_START':
        toast('Sesi kuis dimulai!', 'success');
        sessionStart = Date.now();
        quizEndShown = false;
        lastCountdownVal = -1;
        TTS._lastQIndex = -1;
        break;

      case 'SESSION_RESET':
        toast('Sesi direset', 'warning');
        TTS.cancel();
        TTS._lastQIndex = -1;
        sessionStart = null; quizEndShown = false;
        _prev.scores=''; _prev.question=''; _prev.gesture=''; _prev.statsLen=0;
        markDirty('scores','question','gesture','liveQ','liveTeams','override','analytics','chart');
        break;

      case 'QUIZ_END':
        TTS.cancel();
        if (!quizEndShown) {
          quizEndShown = true;
          setTimeout(() => {
            showPage('dashboard');
            showQuizEndOverlay(ev.data);
            // Baca pengumuman akhir setelah overlay muncul
            setTimeout(() => {
              const teams  = Object.entries(state.teams || {});
              const scores = ev.data.scores || state.scores || {};
              const sorted = [...teams].sort((a,b)=>(scores[b[0]]||0)-(scores[a[0]]||0));
              if (sorted.length > 0) {
                const [wid, winfo] = sorted[0];
                const topScore = scores[wid] || 0;
                const winners  = sorted.filter(([t]) => (scores[t]||0) === topScore);
                const msg = winners.length > 1
                  ? `Kuis selesai! Seri antara ${winners.map(([,i])=>i.name).join(' dan ')}, masing-masing ${topScore} poin.`
                  : `Kuis selesai! Pemenangnya adalah ${winfo.name} dengan skor ${topScore} poin. Selamat!`;
                 soundVictory();
                  TTS.speak(msg, () => {

                // Tepuk tangan setelah TTS selesai
                setTimeout(() => {
                  soundClap();
                }, 300);

              });
              }
            }, 800);
          }, 600);
        }
        break;
    }
  });
}

// ══════════════════════════════════════════════════════════
//  QUIZ END OVERLAY
// ══════════════════════════════════════════════════════════
function showQuizEndOverlay(data) {
  const overlay = document.getElementById('quiz-end-overlay');
  if (!overlay) return;

  const teams  = Object.entries(state.teams || {});
  const scores = data.scores || state.scores || {};
  const stats  = state.stats || [];
  const sorted = [...teams].sort((a,b) => (scores[b[0]]||0) - (scores[a[0]]||0));
  const topScore = scores[sorted[0]?.[0]] || 0;
  const winners  = sorted.filter(([tid]) => (scores[tid]||0) === topScore);
  const isTie    = winners.length > 1;

  const winnerEl = document.getElementById('qeo-winner');
  if (winnerEl) {
    if (isTie) {
      winnerEl.textContent = `🤝 Seri! ${winners.map(([,info])=>info.name).join(' & ')}`;
      winnerEl.style.color = '#d97706';
    } else {
      const [wid, winfo] = sorted[0];
      winnerEl.textContent = `🏆 ${winfo.name} Menang!`;
      winnerEl.style.color = winfo.color;
    }
  }

  const scoresEl = document.getElementById('qeo-scores');
  if (scoresEl) {
    const medal = ['🥇','🥈','🥉'];
    scoresEl.innerHTML = sorted.map(([tid, info], idx) => {
      const s       = scores[tid] || 0;
      const correct = stats.filter(st => st[`correct_${tid}`]).length;
      const acc     = stats.length ? Math.round(correct/stats.length*100) : 0;
      const isWin   = s === topScore;
      return `<div class="qeo-score-item ${isWin?'winner':''}" style="--item-color:${info.color}">
        <div class="qeo-score-rank">${medal[idx]||`#${idx+1}`}</div>
        <div class="qeo-score-name" style="color:${info.color}">${escHtml(info.name)}</div>
        <div class="qeo-score-pts" style="color:${info.color}">${s}</div>
        <div class="qeo-score-sub">${acc}% akurasi</div>
      </div>`;
    }).join('');
  }

  const statsEl = document.getElementById('qeo-stats');
  if (statsEl) {
    const totalQ  = state.total_q || stats.length;
    const allCorr = teams.reduce((sum,[t]) => sum + stats.filter(s=>s[`correct_${t}`]).length, 0);
    const classAcc= teams.length > 0 && stats.length > 0
      ? Math.round(allCorr / (stats.length * teams.length) * 100) : 0;
    const dur = sessionStart ? Math.round((Date.now()-sessionStart)/1000) : 0;
    const m   = Math.floor(dur/60), s2 = dur%60;
    statsEl.innerHTML = `
      <div class="qeo-stat"><div class="qeo-stat-num">${totalQ}</div><div class="qeo-stat-label">Total Soal</div></div>
      <div class="qeo-stat"><div class="qeo-stat-num">${classAcc}%</div><div class="qeo-stat-label">Akurasi Kelas</div></div>
      <div class="qeo-stat"><div class="qeo-stat-num">${m}:${String(s2).padStart(2,'0')}</div><div class="qeo-stat-label">Durasi</div></div>`;
  }

  const actionsEl = document.querySelector('.qeo-actions');
  if (actionsEl) {
    actionsEl.innerHTML = `
      <button class="btn btn-outline" data-action="close">Tutup</button>
      <button class="btn btn-outline" data-action="analytics">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/>
          <line x1="6" y1="20" x2="6" y2="14"/></svg>
        Lihat Analitik
      </button>
      <button class="btn btn-danger" data-action="reset">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.1"/></svg>
        Main Lagi
      </button>`;
  }

  spawnConfetti();
  overlay.classList.add('open');
}

function closeQuizEnd() {
  document.getElementById('quiz-end-overlay')?.classList.remove('open');
}

function spawnConfetti() {
  const container = document.querySelector('.qeo-confetti') || (() => {
    const div = document.createElement('div');
    div.className = 'qeo-confetti';
    document.querySelector('.qeo-inner')?.prepend(div);
    return div;
  })();
  if (!container) return;
  container.innerHTML = '';
  const colors = ['#3b6ef8','#f97316','#10b981','#e11d48','#7c3aed','#f59e0b'];
  for (let i = 0; i < 30; i++) {
    const dot = document.createElement('div');
    dot.className = 'conf-dot';
    dot.style.cssText = `
      left:${Math.random()*100}%;
      background:${colors[Math.floor(Math.random()*colors.length)]};
      animation-delay:${Math.random()*1.5}s;
      animation-duration:${1.5+Math.random()*1.5}s;
      width:${6+Math.random()*6}px; height:${6+Math.random()*6}px;
      border-radius:${Math.random()>0.5?'50%':'3px'};`;
    container.appendChild(dot);
  }
}

// ══════════════════════════════════════════════════════════
//  RAF LOOP
// ══════════════════════════════════════════════════════════
function startRenderLoop() {
  function loop() {
    updateGestureProgress();
    updateSessionTimer();
    updateCountdownFromState();
    rafHandle = requestAnimationFrame(loop);
  }
  rafHandle = requestAnimationFrame(loop);
}

let _cdTrackTs = 0;

function updateCountdownFromState() {
  if (state.state === 'COUNTDOWN') {
    if (_cdTrackTs === 0) _cdTrackTs = Date.now();
    const elapsed   = (Date.now() - _cdTrackTs) / 1000;
    const remaining = elapsed < 3 ? (3 - Math.floor(elapsed)) : 0;
    if (remaining !== lastCountdownVal) {
      lastCountdownVal = remaining;
      soundCountdownTick(remaining);
      showCountdownVisual(remaining);
    }
    if (elapsed >= 3.6) hideCountdownPopup();
  } else {
    if (_cdTrackTs !== 0) {
      _cdTrackTs = 0;
      hideCountdownPopup();
    }
  }
}

function showCountdownVisual(num) {
  const popup  = document.getElementById('countdown-popup');
  const circle = document.getElementById('countdown-circle');
  const numEl  = document.getElementById('countdown-num');
  if (!popup) return;
  popup.classList.add('show');
  if (numEl) numEl.textContent = num === 0 ? 'GO!' : String(num);
  if (circle) {
    const cls = num === 0 ? 'countdown-circle go' : 'countdown-circle';
    if (circle.className !== cls) {
      circle.className = '';
      void circle.offsetWidth;
      circle.className = cls;
    }
  }
  if (num === 0) setTimeout(() => hideCountdownPopup(), 700);
}

function hideCountdownPopup() {
  document.getElementById('countdown-popup')?.classList.remove('show');
  lastCountdownVal = -1;
}

function updateGestureProgress() {
  const gesture = state.gesture || {};
  const lockDur = state.lock_duration || 2;
  const now     = Date.now() / 1000;
  Object.entries(gesture).forEach(([tid, gs]) => {
    const fill = document.getElementById(`gc-fill-${tid}`);
    if (!fill) return;
    let pct = 0;
    if (gs.locked) pct = 1;
    else if (gs.fingers > 0 && gs.start_time) pct = Math.min((now-gs.start_time)/lockDur, 0.99);
    fill.style.transform = `scaleX(${pct})`;
  });
}

function updateSessionTimer() {
  if (!sessionStart) return;
  const sec = Math.round((Date.now()-sessionStart)/1000);
  setTextIfChanged('stat-session-time', `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`);
}

// ══════════════════════════════════════════════════════════
//  RENDER: SCORE CARDS
// ══════════════════════════════════════════════════════════
function renderScoreCards() {
  const container = document.getElementById('score-cards');
  if (!container || !state.teams) return;
  const teams  = Object.entries(state.teams);
  const scores = state.scores || {};
  const stats  = state.stats  || [];
  teams.sort((a,b) => (scores[b[0]]||0)-(scores[a[0]]||0));
  if (container.children.length !== teams.length) {
    container.innerHTML = teams.map(([tid, info]) =>
      `<div class="score-card" id="sc-${tid}" style="--team-color:${info.color}">
        <div class="score-card-rank" id="sc-rank-${tid}"></div>
        <div class="score-card-name">${escHtml(info.name)}</div>
        <div class="score-card-pts" id="sc-pts-${tid}">0</div>
        <div class="score-card-sub" id="sc-sub-${tid}"></div>
      </div>`
    ).join('');
  }
  teams.forEach(([tid], idx) => {
    const score   = scores[tid]||0;
    const correct = stats.filter(s=>s[`correct_${tid}`]).length;
    const acc     = stats.length>0 ? Math.round(correct/stats.length*100) : 0;
    setTextIfChanged(`sc-rank-${tid}`, `#${idx+1} ${idx===0&&teams.length>1?'👑':''}`);
    setTextIfChanged(`sc-pts-${tid}`,  `${score}`);
    setTextIfChanged(`sc-sub-${tid}`,  `Akurasi: ${acc}% · ${correct}/${stats.length} benar`);
  });
}

// ══════════════════════════════════════════════════════════
//  RENDER: TEAM BAR CHART
// ══════════════════════════════════════════════════════════
function renderTeamBarChart() {
  const container = document.getElementById('team-bar-chart');
  if (!container || !state.teams) return;
  const teams = Object.entries(state.teams);
  const stats = state.stats || [];
  if (stats.length === 0) {
    container.innerHTML = `<div class="chart-empty">Belum ada data jawaban</div>`;
    return;
  }
  const rows = teams.map(([tid, info]) => {
    const correct = stats.filter(s => s[`correct_${tid}`]).length;
    const wrong   = stats.length - correct;
    const pctC    = stats.length > 0 ? Math.round(correct/stats.length*100) : 0;
    const pctW    = stats.length > 0 ? Math.round(wrong/stats.length*100) : 0;
    return `<div class="chart-team-row">
      <div class="chart-team-label">
        <span class="chart-team-name">
          <span class="chart-team-dot" style="background:${info.color}"></span>
          ${escHtml(info.name)}
        </span>
        <span class="chart-team-nums">
          <span class="chart-num-correct">✓ ${correct}</span>
          <span class="chart-num-wrong">✗ ${wrong}</span>
        </span>
      </div>
      <div class="chart-bars">
        ${pctC > 0 ? `<div class="chart-bar-correct" style="width:${pctC}%;background:${info.color};opacity:0.85"></div>` : ''}
        ${pctW > 0 ? `<div class="chart-bar-wrong"   style="width:${pctW}%"></div>` : ''}
        ${pctC+pctW === 0 ? `<div class="chart-bar-none"></div>` : ''}
      </div>
    </div>`;
  }).join('');
  container.innerHTML = rows + `
    <div class="chart-legend">
      <span class="chart-legend-item">
        <span class="chart-legend-dot" style="background:var(--success)"></span> Benar
      </span>
      <span class="chart-legend-item">
        <span class="chart-legend-dot" style="background:var(--danger)"></span> Salah
      </span>
      <span style="margin-left:auto;font-size:11px;font-weight:600">${stats.length} soal selesai</span>
    </div>`;
}

// ══════════════════════════════════════════════════════════
//  RENDER: CURRENT QUESTION
// ══════════════════════════════════════════════════════════
function renderCurrentQuestion() {
  const panel = document.getElementById('current-q-panel');
  if (!panel) return;
  const q = state.question;
  if (!q || state.state === 'IDLE') {
    const msg = state.state === 'DASHBOARD' ? 'Kuis selesai! Lihat analitik.' : 'Belum ada soal aktif';
    if (panel.dataset.mode !== 'empty') {
      panel.dataset.mode = 'empty';
      panel.innerHTML = `<div class="no-session">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="1.5" opacity="0.3"><circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <p id="cq-empty-msg"></p></div>`;
    }
    setTextIfChanged('cq-empty-msg', msg);
    return;
  }
  const isResult = state.state === 'RESULT';
  const soalKey  = `${q.soal}:${state.q_index}`;
  if (panel.dataset.soalKey !== soalKey) {
    panel.dataset.soalKey = soalKey;
    panel.dataset.mode    = 'question';
    panel.innerHTML = `
      <div class="cq-label" id="cq-label"></div>
      <div class="cq-text">${escHtml(q.soal)}</div>
      <div class="cq-options">
        ${(q.pilihan||[]).map((opt,i)=>`
          <div class="cq-opt" id="cq-opt-${i}">
            <span class="cq-opt-key">${ANS_LABELS[i+1]}</span>
            <span>${escHtml(opt)}</span>
          </div>`).join('')}
      </div>
      <div id="cq-explain" style="display:none;margin-top:.6rem;font-size:11px;
        color:var(--success);padding:.5rem;background:var(--success-light);border-radius:6px;font-weight:500">
        💡 ${escHtml(q.penjelasan||'')}</div>`;
  }
  const labelText =
    state.state==='COUNTDOWN' ? 'HITUNG MUNDUR...' :
    state.state==='QUESTION'  ? `SOAL ${(state.q_index||0)+1} / ${state.total_q||0} · ⏱ ${state.elapsed_q||0}s` :
    state.state==='RESULT'    ? `SOAL ${(state.q_index||0)+1} / ${state.total_q||0} · HASIL` :
    `SOAL ${(state.q_index||0)+1} / ${state.total_q||0}`;
  setTextIfChanged('cq-label', labelText);
  (q.pilihan||[]).forEach((_,i) => {
    const el = document.getElementById(`cq-opt-${i}`);
    if (el) el.classList.toggle('correct', isResult && (i+1)===q.kunci);
  });
  const expEl = document.getElementById('cq-explain');
  if (expEl) expEl.style.display = isResult && q.penjelasan ? '' : 'none';
}

// ══════════════════════════════════════════════════════════
//  RENDER: GESTURE GRID
// ══════════════════════════════════════════════════════════
function renderGestureGrid() {
  const grid = document.getElementById('gesture-grid');
  if (!grid || !state.teams) return;
  const teams   = Object.entries(state.teams);
  const gesture = state.gesture || {};
  if (grid.children.length !== teams.length) {
    grid.innerHTML = teams.map(([tid, info]) =>
      `<div class="gesture-card" id="gc-${tid}" style="--team-color:${info.color}">
        <div class="gc-header">
          <span class="gc-team-name" style="color:${info.color}">${escHtml(info.name)}</span>
          <span class="gc-status" id="gc-status-${tid}">MENUNGGU</span>
        </div>
        <div class="gc-fingers" id="gc-fingers-${tid}">—</div>
        <div class="gc-answer-label" id="gc-alabel-${tid}">Belum ada gestur</div>
        <div class="gc-progress-bar">
          <div class="gc-progress-fill" id="gc-fill-${tid}"
            style="background:${info.color};transform:scaleX(0);
                   transform-origin:left center;width:100%;will-change:transform"></div>
        </div>
      </div>`
    ).join('');
  }
  teams.forEach(([tid]) => {
    const gs      = gesture[tid]||{};
    const locked  = gs.locked;
    const fingers = gs.fingers||0;
    const answer  = gs.answer||0;
    const display = locked ? answer : fingers;
    const statusLabel = locked?'TERKUNCI':fingers>0?'MENDETEKSI':'MENUNGGU';
    const statusClass = locked?'locked':fingers>0?'detecting':'';
    const resultMark  = state.state==='RESULT'&&state.result
      ? (state.result[tid]?' ✓':' ✗') : '';
    const resultColor = state.state==='RESULT'&&state.result
      ? (state.result[tid]?'var(--success)':'var(--danger)') : 'var(--text-primary)';
    setTextIfChanged(`gc-fingers-${tid}`, `${display||'—'}${resultMark}`);
    const fEl = document.getElementById(`gc-fingers-${tid}`);
    if (fEl && fEl.style.color !== resultColor) fEl.style.color = resultColor;
    const sEl = document.getElementById(`gc-status-${tid}`);
    if (sEl) {
      if (sEl.textContent !== statusLabel) sEl.textContent = statusLabel;
      if (sEl.className !== `gc-status ${statusClass}`) sEl.className = `gc-status ${statusClass}`;
    }
    setTextIfChanged(`gc-alabel-${tid}`,
      display>0 ? `Jawaban: ${ANS_LABELS[display]||'?'}` : 'Belum ada gestur');
  });
}

// ══════════════════════════════════════════════════════════
//  RENDER: ANALYTICS MINI
// ══════════════════════════════════════════════════════════
function updateAnalyticsMini() {
  const stats = state.stats||[];
  const total = state.total_q||0;
  setTextIfChanged('stat-total-q', `${total}`);
  setTextIfChanged('stat-done-q',  `${stats.length}`);
  const teams = Object.keys(state.teams||{});
  if (teams.length>0 && stats.length>0) {
    const all = teams.reduce((sum,t)=>sum+stats.filter(s=>s[`correct_${t}`]).length,0);
    setTextIfChanged('stat-class-acc', `${Math.round(all/(stats.length*teams.length)*100)}%`);
  } else { setTextIfChanged('stat-class-acc','—'); }
}

// ══════════════════════════════════════════════════════════
//  RENDER: LIVE PAGE
// ══════════════════════════════════════════════════════════
function renderLivePage() {
  renderLiveQuestion(); renderLiveTeams();
  buildOverridePanel(); buildSimulatePanel();
  renderZoneIndicators(); updateVideoOverlay();
}

function renderLiveQuestion() {
  const q = state.question;
  if (!document.getElementById('live-q-num')) return;
  if (!q) {
    setTextIfChanged('live-q-num','—');
    setTextIfChanged('live-q-text','Belum ada soal aktif');
    const optsEl = document.getElementById('live-q-options');
    if (optsEl) optsEl.innerHTML='';
    return;
  }
  setTextIfChanged('live-q-num', `Soal ${(state.q_index||0)+1} / ${state.total_q||0}`);
  setTextIfChanged('live-q-text', q.soal);
  const showAns = state.state==='RESULT';
  const optsEl  = document.getElementById('live-q-options');
  const optsKey = `${q.soal}:${showAns}`;
  if (optsEl && optsEl.dataset.key !== optsKey) {
    optsEl.dataset.key = optsKey;
    optsEl.innerHTML   = (q.pilihan||[]).map((opt,i) => {
      const isCorrect = showAns && (i+1)===q.kunci;
      return `<div class="live-q-opt${isCorrect?' correct-ans':''}">
        <span class="opt-key">${ANS_LABELS[i+1]}</span>${escHtml(opt)}</div>`;
    }).join('');
  }
}

function renderLiveTeams() {
  const container = document.getElementById('live-teams');
  if (!container || !state.teams) return;
  const teams   = Object.entries(state.teams);
  const gesture = state.gesture||{};
  const scores  = state.scores||{};
  if (container.children.length !== teams.length) {
    container.innerHTML = teams.map(([tid, info]) =>
      `<div class="live-team-row">
        <div class="lt-color" style="background:${info.color}"></div>
        <div class="lt-name">${escHtml(info.name)}</div>
        <div class="lt-fingers"    id="lt-fingers-${tid}">—</div>
        <div class="lt-lock-status" id="lt-status-${tid}">—</div>
        <div class="lt-score"      id="lt-score-${tid}">0 pts</div>
      </div>`
    ).join('');
  }
  teams.forEach(([tid]) => {
    const gs     = gesture[tid]||{};
    const locked = gs.locked;
    const fingers= gs.fingers||0;
    const answer = gs.answer||0;
    const display= locked ? answer : fingers;
    const resultMark  = state.state==='RESULT'&&state.result
      ? (state.result[tid]?' ✓':' ✗') : '';
    const statusLabel = locked?'TERKUNCI':fingers>0?`${fingers} jari`:'—';
    setTextIfChanged(`lt-fingers-${tid}`, `${display||'—'}${resultMark}`);
    setTextIfChanged(`lt-score-${tid}`,   `${scores[tid]||0} pts`);
    const stEl = document.getElementById(`lt-status-${tid}`);
    if (stEl) {
      if (stEl.textContent !== statusLabel) stEl.textContent = statusLabel;
      stEl.classList.toggle('locked', !!locked);
    }
  });
}

function buildOverridePanel() {
  const panel = document.getElementById('override-panel');
  if (!panel || !state.teams) return;
  const maxOpts = state.settings?.max_options||4;
  panel.innerHTML = Object.entries(state.teams).map(([tid, info]) => {
    const btns = Array.from({length:maxOpts},(_,i)=>{
      const f=i+1;
      return `<button class="ovr-btn" id="ovr-${tid}-${f}"
        onclick="manualAnswer('${tid}',${f})">${ANS_LABELS[f]}</button>`;
    }).join('');
    return `<div class="override-row">
      <div class="override-team-name" style="color:${info.color}">${escHtml(info.name)}</div>
      <div class="override-btns">${btns}</div>
    </div>`;
  }).join('');
}

function updateOverrideBtns() {
  if (!state.teams) return;
  const maxOpts = state.settings?.max_options||4;
  Object.entries(state.teams).forEach(([tid]) => {
    const gs = state.gesture?.[tid]||{};
    for (let f=1; f<=maxOpts; f++) {
      document.getElementById(`ovr-${tid}-${f}`)?.classList.toggle('active', gs.locked && gs.answer===f);
    }
  });
}

function buildSimulatePanel() {
  const panel = document.getElementById('simulate-panel');
  if (!panel || !state.teams) return;
  panel.innerHTML = Object.entries(state.teams).map(([tid, info]) => {
    const btns = [1,2,3,4,5].map(f=>
      `<button class="sim-btn" onclick="simulateGesture('${tid}',${f})">${f}</button>`
    ).join('');
    return `<div class="sim-row">
      <div class="sim-team-label" style="color:${info.color}">${escHtml(info.name)}</div>
      <div class="sim-finger-btns">${btns}</div>
    </div>`;
  }).join('');
}

function renderZoneIndicators() {
  const container = document.getElementById('zone-indicators');
  if (!container || !state.teams) return;
  container.innerHTML = Object.entries(state.teams).map(([tid, info]) =>
    `<div class="zone-ind" style="color:${info.color}">${escHtml(info.name)}</div>`
  ).join('');
}

function updateVideoOverlay() {
  document.getElementById('video-overlay')?.classList.toggle('hidden', !!state.camera_active);
  const btnText = document.getElementById('cam-btn-text');
  if (btnText) btnText.textContent = state.camera_active ? 'Stop Kamera' : 'Mulai Kamera';
}

// ══════════════════════════════════════════════════════════
//  RENDER: QUESTIONS
// ══════════════════════════════════════════════════════════
async function loadQuestions() {
  try {
    const r = await fetch('/api/questions');
    const d = await r.json();
    questions = d.questions||[];
    updateQCount(); renderQuestions(); updateCatFilter();
  } catch(e) { console.error('Failed to load questions',e); }
}

function updateQCount() {
  const el = document.getElementById('q-count');
  if (el) el.textContent = questions.length;
}

function filterQuestions() {
  const search = (document.getElementById('q-search')?.value||'').toLowerCase();
  const cat    = document.getElementById('q-cat-filter')?.value||'';
  renderQuestions(search, cat);
}

function renderQuestions(search='', catFilter='') {
  const list = document.getElementById('question-list');
  if (!list) return;
  const filtered = questions.filter(q => {
    const ms = !search || q.soal?.toLowerCase().includes(search) || q.kategori?.toLowerCase().includes(search);
    const mc = !catFilter || q.kategori===catFilter;
    return ms && mc;
  });
  setTextIfChanged('filter-stats', `${filtered.length} dari ${questions.length} soal`);
  if (filtered.length === 0) {
    list.innerHTML = `<div class="loading-state">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="1.5" opacity="0.3"><circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>Tidak ada soal ditemukan</div>`;
    return;
  }
  list.innerHTML = filtered.map(q => {
    const ri = questions.findIndex(rq=>rq.id===q.id);
    return `<div class="q-item" draggable="true" data-id="${q.id}" data-idx="${ri}"
        ondragstart="dragStart(event)" ondragover="dragOver(event)" ondrop="dragDrop(event)">
      <div class="q-drag-handle">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="9"  cy="5"  r="1" fill="currentColor"/>
          <circle cx="9"  cy="12" r="1" fill="currentColor"/>
          <circle cx="9"  cy="19" r="1" fill="currentColor"/>
          <circle cx="15" cy="5"  r="1" fill="currentColor"/>
          <circle cx="15" cy="12" r="1" fill="currentColor"/>
          <circle cx="15" cy="19" r="1" fill="currentColor"/>
        </svg>
      </div>
      <div class="q-num">${ri+1}</div>
      <div class="q-body">
        <div class="q-soal">${escHtml(q.soal)}</div>
        <div class="q-meta">
          ${q.kategori?`<span class="q-tag cat">${escHtml(q.kategori)}</span>`:''}
          <span class="q-tag key">Kunci: ${ANS_LABELS[q.kunci]||'?'}</span>
          <span class="q-tag score">${q.skor||10} poin</span>
          <span style="font-size:10px;color:var(--text-muted)">${q.pilihan?.length||0} pilihan</span>
        </div>
      </div>
      <div class="q-actions">
        <button class="q-action-btn" onclick="openEditQuestion('${q.id}')" title="Edit">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="q-action-btn" onclick="duplicateQuestion('${q.id}')" title="Duplikat">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button class="q-action-btn del" onclick="confirmDeleteQuestion('${q.id}')" title="Hapus">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');
}

function updateCatFilter() {
  const select = document.getElementById('q-cat-filter');
  if (!select) return;
  const cats = [...new Set(questions.map(q=>q.kategori).filter(Boolean))];
  const cur  = select.value;
  select.innerHTML = `<option value="">Semua Kategori</option>` +
    cats.map(c=>`<option value="${escHtml(c)}" ${c===cur?'selected':''}>${escHtml(c)}</option>`).join('');
}

let dragSrcIdx = null;
function dragStart(e) { dragSrcIdx=parseInt(e.currentTarget.dataset.idx); e.currentTarget.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; }
function dragOver(e)  { e.preventDefault(); e.dataTransfer.dropEffect='move'; }
function dragDrop(e)  {
  e.preventDefault();
  const ti = parseInt(e.currentTarget.dataset.idx);
  if (dragSrcIdx===null||dragSrcIdx===ti) return;
  const moved = questions.splice(dragSrcIdx,1)[0];
  questions.splice(ti,0,moved);
  dragSrcIdx = null;
  saveQuestionsToServer().then(()=>{ renderQuestions(); updateQCount(); });
}

// ══════════════════════════════════════════════════════════
//  QUESTION MODAL
// ══════════════════════════════════════════════════════════
function openAddQuestion() {
  editingQId=null;
  document.getElementById('modal-q-title').textContent='Tambah Soal Baru';
  setVal('mq-id',''); setVal('mq-soal',''); setVal('mq-kat','');
  setVal('mq-kunci','1'); setVal('mq-skor','10'); setVal('mq-penjelasan','');
  resetOptionFields(['','','','']);
  openModal('modal-question');
}

function openEditQuestion(qId) {
  const q = questions.find(q=>q.id===qId);
  if (!q) return;
  editingQId=qId;
  document.getElementById('modal-q-title').textContent='Edit Soal';
  setVal('mq-id',q.id||''); setVal('mq-soal',q.soal||'');
  setVal('mq-kat',q.kategori||''); setVal('mq-kunci',q.kunci||1);
  setVal('mq-skor',q.skor||10); setVal('mq-penjelasan',q.penjelasan||'');
  resetOptionFields(q.pilihan||['','','','']);
  openModal('modal-question');
}

function resetOptionFields(opts=[]) {
  document.getElementById('mq-options-container').innerHTML='';
  optionCount=0;
  opts.forEach(opt=>addOptionField(opt));
}

function addOptionField(value='') {
  if (optionCount>=5) return;
  optionCount++;
  const label=ANS_LABELS[optionCount]||String(optionCount);
  const div=document.createElement('div');
  div.className='opt-input-row'; div.dataset.optIdx=optionCount;
  div.innerHTML=`<span class="opt-label">${label}</span>
    <input type="text" class="opt-input" value="${escAttr(value)}" placeholder="Pilihan ${label}..." style="flex:1">
    <button class="opt-remove" onclick="removeOptionField(this)">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>`;
  document.getElementById('mq-options-container').appendChild(div);
  const btnAdd=document.getElementById('btn-add-opt');
  if (btnAdd) btnAdd.style.display=optionCount>=5?'none':'';
  refreshKunciOptions();
}

function removeOptionField(btn) {
  btn.closest('.opt-input-row').remove();
  const rows=document.querySelectorAll('#mq-options-container .opt-input-row');
  optionCount=0;
  rows.forEach(r=>{
    optionCount++;
    const lbl=r.querySelector('.opt-label');
    if (lbl) lbl.textContent=ANS_LABELS[optionCount]||optionCount;
    r.dataset.optIdx=optionCount;
  });
  const btnAdd=document.getElementById('btn-add-opt');
  if (btnAdd) btnAdd.style.display=optionCount>=5?'none':'';
  refreshKunciOptions();
}

function refreshKunciOptions() {
  const sel=document.getElementById('mq-kunci');
  if (!sel) return;
  const cur=parseInt(sel.value);
  sel.innerHTML=Array.from({length:optionCount},(_,i)=>
    `<option value="${i+1}" ${i+1===cur?'selected':''}>${ANS_LABELS[i+1]} (${i+1} Jari)</option>`
  ).join('');
}

function saveQuestion() {
  const soal=document.getElementById('mq-soal').value.trim();
  if (!soal) { toast('Pertanyaan tidak boleh kosong!','error'); return; }
  const pilihan=Array.from(document.querySelectorAll('#mq-options-container .opt-input'))
    .map(i=>i.value.trim()).filter(Boolean);
  if (pilihan.length<2) { toast('Minimal 2 pilihan jawaban!','error'); return; }
  const kunci=parseInt(document.getElementById('mq-kunci').value);
  if (kunci>pilihan.length) { toast('Kunci melebihi jumlah pilihan!','error'); return; }
  const q={
    id: editingQId||`q${Date.now()}`,
    soal, pilihan, kunci,
    skor:       parseInt(document.getElementById('mq-skor').value)||10,
    kategori:   document.getElementById('mq-kat').value.trim()||'Umum',
    penjelasan: document.getElementById('mq-penjelasan').value.trim(),
  };
  if (editingQId) { const idx=questions.findIndex(x=>x.id===editingQId); if(idx>=0) questions[idx]=q; }
  else questions.push(q);
  saveQuestionsToServer().then(()=>{
    closeModal('modal-question'); renderQuestions(); updateQCount(); updateCatFilter();
    toast(editingQId?'Soal diperbarui!':'Soal ditambahkan!','success');
  });
}

async function saveQuestionsToServer() {
  return fetch('/api/questions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({questions})});
}

function confirmDeleteQuestion(qId) {
  const q=questions.find(x=>x.id===qId);
  showConfirm('Hapus Soal?',`"${q?.soal?.substring(0,60)||qId}..."`,()=>deleteQuestion(qId),'danger');
}
async function deleteQuestion(qId) {
  questions=questions.filter(q=>q.id!==qId);
  await saveQuestionsToServer();
  renderQuestions(); updateQCount(); updateCatFilter();
  toast('Soal dihapus','warning');
}
function duplicateQuestion(qId) {
  const q=questions.find(x=>x.id===qId);
  if (!q) return;
  questions.push({...q,id:`q${Date.now()}`,soal:`[Kopi] ${q.soal}`});
  saveQuestionsToServer().then(()=>{ renderQuestions(); updateQCount(); toast('Soal diduplikat','success'); });
}
function importQuestions() { document.getElementById('import-input')?.click(); }
function initImportHidden() {
  const inp=document.createElement('input');
  inp.type='file'; inp.accept='.json'; inp.id='import-input'; inp.style.display='none';
  inp.addEventListener('change', async e=>{
    const file=e.target.files[0]; if(!file) return;
    try {
      const data=JSON.parse(await file.text());
      let imported=data.questions||(Array.isArray(data)?data:null);
      if (!imported) { toast('Format JSON tidak valid','error'); return; }
      imported=imported.map((q,i)=>({
        id:q.id||`q${Date.now()}_${i}`, soal:q.soal||q.question||'',
        pilihan:q.pilihan||q.options||[], kunci:q.kunci||q.answer||1,
        skor:q.skor||q.points||10, kategori:q.kategori||q.category||'Umum',
        penjelasan:q.penjelasan||q.explanation||'',
      }));
      questions=[...questions,...imported];
      await saveQuestionsToServer();
      renderQuestions(); updateQCount(); updateCatFilter();
      toast(`${imported.length} soal diimport!`,'success');
    } catch { toast('Gagal memproses file JSON','error'); }
    inp.value='';
  });
  document.body.appendChild(inp);
}

// ══════════════════════════════════════════════════════════
//  TEAM PAGE
// ══════════════════════════════════════════════════════════
function renderTeamPage() {
  const n=settings.num_teams||2;
  document.querySelectorAll('.count-btn').forEach(btn=>
    btn.classList.toggle('active',parseInt(btn.dataset.count)===n));
  renderZonePreview(n); renderPositionGuide(n); renderTeamConfigList(n); renderLeaderboard();
}
function setTeamCount(n) { settings.num_teams=n; renderTeamPage(); }

function renderZonePreview(n) {
  const c=document.getElementById('team-zone-preview'); if(!c) return;
  const colors=settings.team_colors||TEAM_COLORS;
  const names =settings.team_names||[];
  c.innerHTML=Array.from({length:n},(_,i)=>
    `<div class="zone-block" style="color:${colors[i]||TEAM_COLORS[i]};background:${colors[i]||TEAM_COLORS[i]}18">
      ${names[i]||`Tim ${i+1}`}</div>`
  ).join('');
}

function renderPositionGuide(n) {
  const g = document.getElementById('position-guide'); if (!g) return;
  const colors = settings.team_colors || TEAM_COLORS;
  const names  = settings.team_names || [];
  const pos = n===2 ? ['KIRI','KANAN']
    : n===3 ? ['KIRI','TENGAH','KANAN']
    : n===4 ? ['KIRI','TENGAH-KIRI','TENGAH-KANAN','KANAN']
    : Array.from({length:n},(_,i)=>`POSISI ${i+1}`);
  g.innerHTML = Array.from({length:n},(_,i)=>`
    <div class="pos-row">
      <div class="pos-indicator" style="background:${colors[i]||TEAM_COLORS[i]}"></div>
      <strong>${names[i]||`Tim ${i+1}`}</strong>
      <span style="color:var(--text-muted);margin-left:auto">→ Zona ${pos[i]}</span>
    </div>`).join('');
}

function renderTeamConfigList(n) {
  const c=document.getElementById('team-config-list'); if(!c) return;
  const colors=settings.team_colors||TEAM_COLORS;
  const names =settings.team_names||[];
  c.innerHTML=Array.from({length:n},(_,i)=>
    `<div class="team-cfg-row">
      <input type="color" class="team-cfg-color" id="tc-color-${i}" value="${colors[i]||TEAM_COLORS[i]}">
      <div class="team-cfg-inputs">
        <input type="text" id="tc-name-${i}" value="${escAttr(names[i]||`Tim ${i+1}`)}" placeholder="Nama Tim ${i+1}">
      </div>
      <span style="font-size:11px;color:var(--text-muted);white-space:nowrap">Zona ${i+1}</span>
    </div>`
  ).join('');
}

async function saveTeamConfig() {
  const n=settings.num_teams||2;
  settings.team_names  = Array.from({length:n},(_,i)=>document.getElementById(`tc-name-${i}`)?.value||`Tim ${i+1}`);
  settings.team_colors = Array.from({length:n},(_,i)=>document.getElementById(`tc-color-${i}`)?.value||TEAM_COLORS[i]);
  await postJSON('/api/settings',settings);
  toast('Konfigurasi tim disimpan!','success'); renderTeamPage();
}

function renderLeaderboard() {
  const lb=document.getElementById('leaderboard');
  if (!lb||!state.teams) return;
  const teams=Object.entries(state.teams);
  const scores=state.scores||{};
  const stats=state.stats||[];
  teams.sort((a,b)=>(scores[b[0]]||0)-(scores[a[0]]||0));
  if (!teams.length) { lb.innerHTML=`<div class="loading-state">Belum ada data.</div>`; return; }
  const medal=['🥇','🥈','🥉'];
  lb.innerHTML=teams.map(([tid,info],idx)=>{
    const s=scores[tid]||0;
    const c=stats.filter(st=>st[`correct_${tid}`]).length;
    const ac=stats.length?Math.round(c/stats.length*100):0;
    const rc=idx===0?'first':idx===1?'second':idx===2?'third':'';
    return `<div class="lb-row ${rc}">
      <div class="lb-rank">${medal[idx]||idx+1}</div>
      <div class="lb-color" style="background:${info.color}"></div>
      <div class="lb-name">${escHtml(info.name)}</div>
      <div class="lb-acc">${ac}%</div>
      <div class="lb-score">${s} pts</div>
    </div>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════════════════════════
async function loadSettings() {
  try { const r=await fetch('/api/settings'); settings=await r.json(); populateSettings(); }
  catch(e) { console.error('Failed to load settings'); }
}

function populateSettings() {
  const ld  = settings.lock_duration   ?? 2;
  const rd  = settings.result_duration ?? 4;
  const ci  = settings.camera_index    ?? 0;
  const mo  = settings.max_options     ?? 4;
  setVal('s-title',      settings.session_title || 'Gesture Quiz – Classroom Battle');
  setVal('s-lock-dur',   ld);
  setVal('s-result-dur', rd);
  setVal('s-cam-idx',    ci);
  setChecked('s-partial',  settings.allow_partial_teams  !== false);
  setChecked('s-show-ans', settings.show_answer_immediately !== false);
  setVal('s-max-opts',   mo);
  setText('s-lock-dur-val',   `${ld}s`);
  setText('s-result-dur-val', `${rd}s`);
}

function initSliders() {
  document.getElementById('s-lock-dur')?.addEventListener('input',  e=>setText('s-lock-dur-val',`${e.target.value}s`));
  document.getElementById('s-result-dur')?.addEventListener('input', e=>setText('s-result-dur-val',`${e.target.value}s`));
}

async function saveSettings() {
  const title    = getVal('s-title').trim() || 'Gesture Quiz – Classroom Battle';
  const lockDur  = parseFloat(getVal('s-lock-dur'));
  const resDur   = parseInt(getVal('s-result-dur'));
  const camIdx   = parseInt(getVal('s-cam-idx'));
  const maxOpts  = parseInt(getVal('s-max-opts'));
  const s = {
    ...settings,
    session_title:           title,
    lock_duration:           isNaN(lockDur) ? 2 : Math.max(0.5, Math.min(5, lockDur)),
    result_duration:         isNaN(resDur)  ? 4 : Math.max(2, Math.min(10, resDur)),
    camera_index:            isNaN(camIdx)  ? 0 : Math.max(0, Math.min(5, camIdx)),
    allow_partial_teams:     getChecked('s-partial'),
    show_answer_immediately: getChecked('s-show-ans'),
    max_options:             isNaN(maxOpts) ? 4 : Math.max(2, Math.min(5, maxOpts)),
  };
  try {
    const r = await postJSON('/api/settings', s);
    if (!r.ok) { toast('Gagal menyimpan (server error)','error'); return; }
    const d = await r.json();
    if (d.ok) {
      settings = s;
      setText('s-lock-dur-val',   `${s.lock_duration}s`);
      setText('s-result-dur-val', `${s.result_duration}s`);
      toast('✓ Pengaturan berhasil disimpan!','success');
    } else { toast(`Gagal: ${d.error || 'unknown'}`, 'error'); }
  } catch(err) {
    console.error('saveSettings error:', err);
    toast('Gagal menyimpan (network error)','error');
  }
}

// ══════════════════════════════════════════════════════════
//  ANALYTICS
// ══════════════════════════════════════════════════════════
async function loadAnalytics() {
  const c=document.getElementById('analytics-detail'); if(!c) return;
  c.innerHTML=`<div class="loading-state"><div class="spinner"></div>Memuat analitik...</div>`;
  try { const d=await(await fetch('/api/analytics')).json(); renderAnalyticsDetail(d); }
  catch { c.innerHTML=`<div class="loading-state">Gagal memuat.</div>`; }
}

function renderAnalyticsDetail(d) {
  const c=document.getElementById('analytics-detail');
  if (!c||!state.teams) return;
  const teams=Object.entries(state.teams);
  const scores=d.scores||{};
  const acc=d.accuracy||{};
  const stats=d.stats||[];
  const avgRt=d.avg_response_time||{};
  const accCards=teams.map(([tid,info])=>{
    const pct=acc[tid]||0;
    return `<div class="acc-card">
      <div class="acc-team-name" style="color:${info.color}">${escHtml(info.name)}</div>
      <div class="acc-pct" style="color:${info.color}">${pct}%</div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px">
        ${scores[tid]||0} pts · ⏱ ${avgRt[tid]||'—'}s avg</div>
      <div class="acc-bar"><div class="acc-bar-fill" style="width:${pct}%;background:${info.color}"></div></div>
    </div>`;
  }).join('');
  const qRows=stats.map((s,i)=>{
    const res=teams.map(([tid,info])=>{
      const correct=s[`correct_${tid}`]; const ans=s[`answer_${tid}`];
      const cls=!ans?'no-ans':correct?'correct':'wrong';
      return `<div class="qs-res ${cls}" title="${info.name}: ${ANS_LABELS[ans]||'—'}">${ANS_LABELS[ans]||'—'}</div>`;
    }).join('');
    return `<div class="q-stat-row">
      <span class="qs-num">${i+1}</span>
      <span class="qs-soal" title="${escAttr(s.soal)}">${escHtml(s.soal)}</span>
      <div class="qs-team-results">${res}</div>
    </div>`;
  }).join('')||`<div class="loading-state">Belum ada data.</div>`;
  const hardestBlock=d.hardest
    ?`<div class="card" style="border-color:rgba(217,119,6,0.25);background:var(--warning-light)">
        <div style="font-size:11px;color:var(--warning);font-family:var(--font-mono);margin-bottom:.4rem;font-weight:700">SOAL PALING SULIT</div>
        <div style="font-size:13px;color:var(--text-primary);font-weight:500">${escHtml(d.hardest)}</div>
      </div>` : '';
  c.innerHTML=`
    <div class="analytics-detail-grid">${accCards}</div>
    ${hardestBlock}
    <div class="card">
      <div class="card-header"><h3>Detail Jawaban per Soal</h3>
        <div style="display:flex;gap:.4rem">
          ${teams.map(([tid,info])=>`<span style="font-size:10px;font-family:var(--font-mono);color:${info.color};font-weight:700">${info.name}</span>`).join(' ')}
        </div>
      </div>
      <div class="q-stat-grid">${qRows}</div>
    </div>`;
}

// ══════════════════════════════════════════════════════════
//  SESSION CONTROLS
// ══════════════════════════════════════════════════════════
async function startSession() {
  const r=await postJSON('/api/session/start',{});
  const d=await r.json();
  if (!d.ok) { toast(d.message||'Tidak bisa memulai','warning'); return; }
  await postJSON('/api/camera/start',{});
  showPage('live');
  setTimeout(() => {
    const img = document.getElementById('video-feed');
    if (img && !img.src.includes('/api/video')) img.src = '/api/video';
    document.getElementById('video-overlay')?.classList.add('hidden');
    toast('Kuis dimulai! Kamera aktif.','success');
  }, 150);
}

async function resetSession() {
  showConfirm('Reset Sesi?','Semua skor dan progres akan dihapus.',async()=>{
    TTS.cancel();
    await postJSON('/api/session/reset',{});
  });
}
async function nextQuestion() { await postJSON('/api/session/next',{}); }
async function prevQuestion() { await postJSON('/api/session/prev',{}); }
function  quickStart()        { startSession(); }

async function toggleCamera() {
  if (state.camera_active) {
    await postJSON('/api/camera/stop',{});
    toast('Kamera dimatikan','warning');
  } else {
    await postJSON('/api/camera/start',{});
    toast('Kamera dinyalakan','success');
  }
}

async function manualAnswer(teamId, answerIdx) {
  await postJSON('/api/answer/manual',{team:teamId,answer:answerIdx});
}
async function simulateGesture(teamId, fingers) {
  await postJSON('/api/gesture/simulate',{team:teamId,fingers});
  toast(`Sim: ${getTeamName(teamId)} → ${fingers} jari (${ANS_LABELS[fingers]})`,'success');
}
function exportData() { window.open('/api/export/json','_blank'); }

// ══════════════════════════════════════════════════════════
//  VISUAL FEEDBACK
// ══════════════════════════════════════════════════════════
function showAnswerPopup(result, scores) {
  if (!result || !state.teams) return;
  const teams    = Object.entries(state.teams);
  const allRight = teams.every(([t]) => result[t]);
  const allWrong = teams.every(([t]) => !result[t]);
  const overlay = document.getElementById('answer-popup-overlay');
  const popup   = document.getElementById('answer-popup');
  const icon    = document.getElementById('popup-icon');
  const title   = document.getElementById('popup-title');
  const rowEl   = document.getElementById('popup-answer-row');
  const corAns  = document.getElementById('popup-correct-ans');
  if (!overlay || !popup) return;
  popup.className = 'answer-popup ' + (allRight ? 'correct' : allWrong ? 'wrong' : 'mixed');
  if (allRight)       { icon.textContent='🎉'; title.textContent='Semua Benar!'; }
  else if (allWrong)  { icon.textContent='😬'; title.textContent='Semua Salah!'; }
  else                { icon.textContent='🤔'; title.textContent='Ada yang Benar, Ada yang Salah'; }
  rowEl.innerHTML = teams.map(([tid, info]) => {
    const gs      = state.gesture?.[tid] || {};
    const correct = result[tid];
    const ans     = gs.answer || 0;
    const noAns   = !ans;
    const cls     = noAns ? 'no-ans' : correct ? 'correct' : 'wrong';
    const ansLbl  = ans ? ANS_LABELS[ans] : '—';
    const icon2   = noAns ? '—' : correct ? '✓' : '✗';
    return `<div class="popup-team-chip ${cls}" style="color:${info.color};border-color:${info.color}33;background:${info.color}14">
      <span style="font-size:15px">${icon2}</span>
      <span>${escHtml(info.name)}: ${ansLbl}</span>
    </div>`;
  }).join('');
  const q = state.question;
  if (q) {
    const kunci   = q.kunci;
    const correct = q.pilihan?.[kunci-1] || '';
    corAns.innerHTML = `Jawaban benar: <strong>${ANS_LABELS[kunci]} — ${escHtml(correct)}</strong>`;
  }
  overlay.classList.add('show');
  if (answerPopupTimer) clearTimeout(answerPopupTimer);
  answerPopupTimer = setTimeout(() => closeAnswerPopup(), 3500);
}

function closeAnswerPopup() {
  document.getElementById('answer-popup-overlay')?.classList.remove('show');
  if (answerPopupTimer) { clearTimeout(answerPopupTimer); answerPopupTimer = null; }
}

function showResultFlash(result) {
  if (!result||!state.teams) return;
  const teams=Object.keys(state.teams);
  const allRight=teams.every(t=>result[t]);
  const allWrong=teams.every(t=>!result[t]);
  let flashEl=document.getElementById('result-flash');
  if (!flashEl) {
    flashEl=document.createElement('div');
    flashEl.id='result-flash'; flashEl.className='result-flash';
    document.body.appendChild(flashEl);
  }
  flashEl.style.background=allRight?'rgba(5,150,105,0.1)':allWrong?'rgba(220,38,38,0.08)':'rgba(59,110,248,0.08)';
  flashEl.classList.add('show');
  setTimeout(()=>flashEl.classList.remove('show'),600);
}

// ══════════════════════════════════════════════════════════
//  MODAL
// ══════════════════════════════════════════════════════════
function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }
function showConfirm(title,desc,onOk,type='danger') {
  setTextIfChanged('confirm-title',title);
  setTextIfChanged('confirm-desc',desc);
  const btn=document.getElementById('confirm-ok-btn');
  btn.className=`btn btn-${type}`;
  btn.onclick=()=>{ closeModal('modal-confirm'); onOk(); };
  openModal('modal-confirm');
}

// ══════════════════════════════════════════════════════════
//  TOAST
// ══════════════════════════════════════════════════════════
function toast(msg,type='success') {
  const container=document.getElementById('toast-container');
  const el=document.createElement('div');
  el.className=`toast ${type}`;
  const icons={
    success:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    error:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    warning:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  };
  el.innerHTML=`<span class="toast-icon">${icons[type]||icons.success}</span>${escHtml(msg)}`;
  container.appendChild(el);
  setTimeout(()=>{ el.classList.add('dying'); setTimeout(()=>el.remove(),350); },3000);
}

// ══════════════════════════════════════════════════════════
//  DOM UTILS
// ══════════════════════════════════════════════════════════
function setTextIfChanged(id,txt) { const el=document.getElementById(id); if(el&&el.textContent!==txt) el.textContent=txt; }
function setText(id,txt)  { const el=document.getElementById(id); if(el) el.textContent=txt; }
function setVal(id,val)   { const el=document.getElementById(id); if(el) el.value=val; }
function getVal(id)       { return document.getElementById(id)?.value||''; }
function setChecked(id,v) { const el=document.getElementById(id); if(el) el.checked=v; }
function getChecked(id)   { return document.getElementById(id)?.checked||false; }
function getTeamName(tid) { return state.teams?.[tid]?.name||tid; }
function escHtml(str)     { return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
function escAttr(str)     { return String(str||'').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
async function postJSON(url,data) { return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}); }