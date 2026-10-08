"""
╔══════════════════════════════════════════════════════════════════════╗
║                    GESTURE-QUIZ — Web Control Server                 ║
╚══════════════════════════════════════════════════════════════════════╝
"""

from flask import Flask, request, jsonify, render_template, Response
import threading
import json
import time
import os
import queue
from collections import defaultdict, deque
from datetime import datetime

try:
    import cv2
    import mediapipe as mp
    CV2_AVAILABLE = True
except ImportError:
    CV2_AVAILABLE = False
    print("[WARN] OpenCV/MediaPipe tidak tersedia – mode demo aktif.")

try:
    import pygame
    pygame.mixer.init(frequency=44100, size=-16, channels=2, buffer=512)
    PYGAME_AVAILABLE = True
except Exception:
    PYGAME_AVAILABLE = False

# ══════════════════════════════════════════════════════════════════════
#  KONFIGURASI
# ══════════════════════════════════════════════════════════════════════

LOCK_DURATION   = 2.0
RESULT_DURATION = 4.0
ANSWER_LABELS   = {1: "A", 2: "B", 3: "C", 4: "D", 5: "E"}
DATA_FILE       = os.path.join(os.path.dirname(__file__), "data", "quiz_data.json")

# Resolusi: kamera → MediaPipe → output stream
MP_PROC_W   = 640
MP_PROC_H   = 360
OUT_W       = 854
OUT_H       = 480
JPEG_QUALITY= 65

# Jari dianggap "stabil" setelah terdeteksi N frame berturut-turut
FINGER_STABLE_FRAMES = 3

DEFAULT_QUESTIONS = [
    {"id":"q1","soal":"Apa kepanjangan dari 'CPU'?",
     "pilihan":["Central Process Unit","Computer Personal Unit","Central Processing Unit","Core Processing Utility"],
     "kunci":3,"penjelasan":"CPU = Central Processing Unit","skor":10,"kategori":"Hardware"},
    {"id":"q2","soal":"Berapa jumlah bit dalam 1 Byte?",
     "pilihan":["4 bit","8 bit","16 bit","32 bit"],
     "kunci":2,"penjelasan":"1 Byte = 8 bit","skor":10,"kategori":"Dasar"},
    {"id":"q3","soal":"Apa fungsi utama RAM pada komputer?",
     "pilihan":["Menyimpan data permanen","Memproses grafis","Menyimpan data sementara","Mengatur daya listrik"],
     "kunci":3,"penjelasan":"RAM = Random Access Memory, menyimpan data sementara","skor":10,"kategori":"Hardware"},
    {"id":"q4","soal":"Format file gambar mana yang mendukung transparansi?",
     "pilihan":["JPEG","BMP","PNG","TIFF"],
     "kunci":3,"penjelasan":"PNG mendukung saluran alpha (transparansi)","skor":10,"kategori":"Multimedia"},
    {"id":"q5","soal":"Berapa frame per second (FPS) standar video HD?",
     "pilihan":["15 FPS","24 FPS","30 FPS","60 FPS"],
     "kunci":3,"penjelasan":"30 FPS adalah standar video HD broadcast","skor":10,"kategori":"Multimedia"},
    {"id":"q6","soal":"Apa singkatan dari 'HTML'?",
     "pilihan":["Hyper Text Markup Language","High Tech Modern Language","Hyper Transfer Media Link","Home Tool Markup Language"],
     "kunci":1,"penjelasan":"HTML = HyperText Markup Language","skor":15,"kategori":"Web"},
    {"id":"q7","soal":"Warna RGB (255, 0, 0) menghasilkan warna apa?",
     "pilihan":["Hijau","Biru","Merah","Putih"],
     "kunci":3,"penjelasan":"R=255, G=0, B=0 menghasilkan warna Merah murni","skor":10,"kategori":"Multimedia"},
    {"id":"q8","soal":"Komponen multimedia mana yang TIDAK termasuk 5 elemen dasar?",
     "pilihan":["Teks","Grafik","Database","Video"],
     "kunci":3,"penjelasan":"5 elemen dasar: Teks, Grafik, Audio, Video, Animasi","skor":20,"kategori":"Multimedia"},
]

DEFAULT_SETTINGS = {
    "num_teams":2,
    "team_names":["Tim A","Tim B","Tim C","Tim D"],
    "team_colors":["#FF7822","#2278FF","#22CC88","#CC2288"],
    "lock_duration":2.0,
    "result_duration":4.0,
    "camera_index":0,
    "show_answer_immediately":True,
    "allow_partial_teams":True,
    "session_title":"Gesture Quiz – Classroom Battle",
    "max_options":4,
}

# ══════════════════════════════════════════════════════════════════════
#  FRAME BUFFER — lock-free atomic swap untuk MJPEG
# ══════════════════════════════════════════════════════════════════════

class FrameBuffer:
    def __init__(self):
        self._lock = threading.Lock()
        self._buf  = None
        self._ts   = 0.0

    def write(self, jpeg: bytes):
        with self._lock:
            self._buf = jpeg
            self._ts  = time.monotonic()

    def read(self):
        with self._lock:
            return self._buf, self._ts

frame_buffer = FrameBuffer()

# ══════════════════════════════════════════════════════════════════════
#  DATA PERSISTENCE
# ══════════════════════════════════════════════════════════════════════

def load_data():
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE,"r",encoding="utf-8") as f:
                data = json.load(f)
            return data.get("questions", DEFAULT_QUESTIONS), \
                   {**DEFAULT_SETTINGS, **data.get("settings",{})}
        except Exception as e:
            print(f"[DATA] Gagal memuat: {e}")
    return list(DEFAULT_QUESTIONS), dict(DEFAULT_SETTINGS)

def save_data(questions, settings):
    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    try:
        with open(DATA_FILE,"w",encoding="utf-8") as f:
            json.dump({"questions":questions,"settings":settings,
                       "updated_at":datetime.now().isoformat()},
                      f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        print(f"[DATA] Gagal simpan: {e}")
        return False

# ══════════════════════════════════════════════════════════════════════
#  GAME STATE  — satu lock, tidak ada nested lock
# ══════════════════════════════════════════════════════════════════════

class GameState:
    """
    Aturan lock:
    • Semua mutasi data melalui self._lock
    • push_event() TIDAK boleh dipanggil di dalam self._lock
    • Semua event di-queue dulu, lalu di-push setelah lock dilepas
    """

    def __init__(self):
        self._lock      = threading.Lock()
        self._ev_queue  = queue.SimpleQueue()   # lock-free event bus

        self._questions, self._settings = load_data()
        self._state     = "IDLE"
        self._q_index   = 0
        self._scores    = {}
        self._gesture   = {}
        self._q_start   = None
        self._result_ts = None
        self._result    = {}
        self._stats     = []
        self._response_times = defaultdict(list)
        self._countdown_start = None
        self._session_id = None
        self._camera_active = False
        self._init_teams()

        # Event store untuk SSE pop
        self._events    = []

        # Background thread: drain ev_queue → _events
        threading.Thread(target=self._drain_events, daemon=True).start()

    def _drain_events(self):
        while True:
            ev = self._ev_queue.get()
            with self._lock:
                self._events.append(ev)
                if len(self._events) > 300:
                    self._events = self._events[-150:]

    def _init_teams(self):
        n      = self._settings.get("num_teams", 2)
        names  = self._settings.get("team_names",  [])
        colors = self._settings.get("team_colors", [])
        self._scores  = {f"T{i+1}": 0 for i in range(n)}
        self._gesture = {
            f"T{i+1}": {"fingers":0,"start_time":None,"locked":False,"answer":0}
            for i in range(n)
        }
        self._team_info = {
            f"T{i+1}": {
                "name":  names[i]  if i < len(names)  else f"Tim {i+1}",
                "color": colors[i] if i < len(colors) else "#888888",
            }
            for i in range(n)
        }

    # ── Event System ─────────────────────────────────────────────────
    def _enqueue(self, etype, data=None):
        """Kirim event ke queue — AMAN dipanggil di dalam lock."""
        self._ev_queue.put({"type":etype,"data":data or {},"ts":time.time()})

    def pop_events(self, since_ts=0):
        with self._lock:
            return [e for e in self._events if e["ts"] > since_ts]

    # ── Snapshot ─────────────────────────────────────────────────────
    def snapshot(self):
        """Ambil snapshot lengkap — SATU kali lock."""
        with self._lock:
            q = None
            if 0 <= self._q_index < len(self._questions):
                q = self._questions[self._q_index]
            now = time.time()
            return {
                "state":        self._state,
                "q_index":      self._q_index,
                "total_q":      len(self._questions),
                "question":     q,
                "scores":       dict(self._scores),
                "gesture":      {k: dict(v) for k, v in self._gesture.items()},
                "result":       dict(self._result),
                "stats":        list(self._stats),
                "teams":        dict(self._team_info),
                "elapsed_q":    round(now - self._q_start, 1)    if self._q_start  else 0,
                "elapsed_r":    round(now - self._result_ts, 1)  if self._result_ts else 0,
                "lock_duration": self._settings.get("lock_duration", LOCK_DURATION),
                "camera_active": self._camera_active,
                "session_id":   self._session_id,
                "settings":     dict(self._settings),
                "response_times": {k: list(v) for k, v in self._response_times.items()},
            }

    # ── Getters ───────────────────────────────────────────────────────
    def get_questions(self):
        with self._lock: return list(self._questions)

    def get_settings(self):
        with self._lock: return dict(self._settings)

    # ── Setters ───────────────────────────────────────────────────────
    def set_questions(self, questions):
        with self._lock:
            self._questions = questions
        save_data(self._questions, self._settings)

    def set_settings(self, settings):
        with self._lock:
            self._settings = {**self._settings, **settings}
            # Hanya re-init teams jika tidak ada sesi aktif
            # agar skor tidak direset saat guru simpan pengaturan di tengah sesi
            if self._state in ("IDLE", "DASHBOARD"):
                self._init_teams()
        save_data(self._questions, self._settings)

    # ── Session Control ───────────────────────────────────────────────
    def start_session(self):
        with self._lock:
            if self._state not in ("IDLE","DASHBOARD"):
                return False
            self._q_index    = 0
            self._stats      = []
            self._response_times = defaultdict(list)
            self._session_id = datetime.now().strftime("%Y%m%d_%H%M%S")
            self._init_teams()
            self._state      = "COUNTDOWN"
            self._countdown_start = time.time()
            sid = self._session_id
        self._enqueue("SESSION_START", {"session_id": sid})
        return True

    def reset_session(self):
        with self._lock:
            self._state      = "IDLE"
            self._q_index    = 0
            self._stats      = []
            self._result     = {}
            self._session_id = None
            self._init_teams()
        self._enqueue("SESSION_RESET")

    def force_next(self):
        event = None
        with self._lock:
            if self._state == "QUESTION":
                for gs in self._gesture.values():
                    if not gs["locked"]:
                        gs["answer"] = gs["fingers"]
                        gs["locked"] = True
                # langsung evaluate
                event = self._do_evaluate_locked()
            elif self._state == "RESULT":
                event = self._do_advance_locked()
        if event:
            self._enqueue(*event)

    def force_prev(self):
        with self._lock:
            if self._q_index > 0 and self._state in ("QUESTION","RESULT"):
                if self._stats:
                    last = self._stats.pop()
                    for t in self._scores:
                        if last.get(f"correct_{t}"):
                            skor = self._questions[max(0,self._q_index-1)].get("skor",10)
                            self._scores[t] = max(0, self._scores[t] - skor)
                self._q_index -= 1
                self._result   = {}
                self._state    = "COUNTDOWN"
                self._countdown_start = time.time()
                for gs in self._gesture.values():
                    gs.update({"fingers":0,"start_time":None,"locked":False,"answer":0})

    def manual_set_answer(self, team_id, answer_idx):
        event = None
        with self._lock:
            if team_id in self._gesture and self._state == "QUESTION":
                gs = self._gesture[team_id]
                gs["answer"]  = answer_idx
                gs["locked"]  = True
                gs["fingers"] = answer_idx
                self._response_times[team_id].append(
                    time.time() - self._q_start if self._q_start else 0)
                self._enqueue("ANSWER_LOCKED", {"team":team_id,"answer":answer_idx})
                # Cek apakah semua tim sudah terkunci
                if all(g["locked"] for g in self._gesture.values()):
                    event = self._do_evaluate_locked()
        if event:
            self._enqueue(*event)

    # ── Internal evaluate & advance (dipanggil di DALAM lock) ─────────
    def _do_evaluate_locked(self):
        """Evaluasi jawaban. Harus di dalam self._lock. Return (event_type, data) atau None."""
        q     = self._questions[self._q_index]
        kunci = q.get("kunci", 1)
        skor  = q.get("skor", 10)
        result= {}
        stat  = {"q_index": self._q_index, "soal": q["soal"]}
        for t, gs in self._gesture.items():
            correct = gs["answer"] == kunci
            result[t] = correct
            stat[f"correct_{t}"] = correct
            stat[f"answer_{t}"]  = gs["answer"]
            if correct:
                self._scores[t] = self._scores.get(t, 0) + skor
        self._result    = result
        self._result_ts = time.time()
        self._state     = "RESULT"
        self._stats.append(stat)
        return ("RESULT", {"result": result, "scores": dict(self._scores)})

    def _do_advance_locked(self):
        """Pindah soal. Harus di dalam self._lock. Return (event_type, data) atau None."""
        self._q_index += 1
        if self._q_index >= len(self._questions):
            self._state = "DASHBOARD"
            return ("QUIZ_END", {"scores": dict(self._scores)})
        else:
            self._state = "COUNTDOWN"
            self._countdown_start = time.time()
            for gs in self._gesture.values():
                gs.update({"fingers":0,"start_time":None,"locked":False,"answer":0})
            return ("QUESTION_NEXT", {"q_index": self._q_index})

    # ── Gesture Update ────────────────────────────────────────────────
    def update_gesture(self, team_id: str, fingers: int):
        """
        Dipanggil dari GameLoop. Lock sesingkat mungkin.
        Return event string jika ada yang perlu di-enqueue, else None.
        """
        event = None
        with self._lock:
            if team_id not in self._gesture or self._state != "QUESTION":
                return
            gs = self._gesture[team_id]
            if gs["locked"]:
                return
            now      = time.time()
            lock_dur = self._settings.get("lock_duration", LOCK_DURATION)

            if fingers > 0:
                if gs["fingers"] != fingers:
                    # Jari berubah — reset timer
                    gs["fingers"]    = fingers
                    gs["start_time"] = now
                else:
                    # Jari sama — cek apakah sudah cukup lama
                    if gs["start_time"] is None:
                        gs["start_time"] = now
                    elif now - gs["start_time"] >= lock_dur:
                        gs["locked"] = True
                        gs["answer"] = fingers
                        if self._q_start:
                            self._response_times[team_id].append(now - self._q_start)
                        # Cek apakah SEMUA tim sudah locked
                        if all(g["locked"] for g in self._gesture.values()):
                            ev_data = self._do_evaluate_locked()
                            event = ("RESULT_BATCH", ev_data)
                        else:
                            event = ("ANSWER_LOCKED", {"team":team_id,"answer":fingers})
            else:
                gs["fingers"]    = 0
                gs["start_time"] = None

        # Push event di LUAR lock
        if event:
            if event[0] == "RESULT_BATCH":
                # ev_data adalah tuple (etype, data)
                self._enqueue(event[1][0], event[1][1])
            else:
                self._enqueue(event[0], event[1])

    # ── State Machine Tick ────────────────────────────────────────────
    def tick(self):
        """
        Dipanggil dari GameLoop (kamera aktif) atau background_tick (kamera mati).
        TIDAK mengambil lock lebih dari sekali, tidak nested.
        """
        event = None
        with self._lock:
            state = self._state
            now   = time.time()

            if state == "COUNTDOWN":
                elapsed = now - (self._countdown_start or now)
                if elapsed >= 3.0:
                    self._state   = "QUESTION"
                    self._q_start = now
                    for gs in self._gesture.values():
                        gs.update({"fingers":0,"start_time":None,"locked":False,"answer":0})
                    event = ("QUESTION_START", {"q_index": self._q_index})

            elif state == "QUESTION":
                if all(gs["locked"] for gs in self._gesture.values()):
                    event = self._do_evaluate_locked()

            elif state == "RESULT":
                elapsed = now - (self._result_ts or now)
                dur     = self._settings.get("result_duration", RESULT_DURATION)
                if elapsed >= dur:
                    event = self._do_advance_locked()

        if event:
            self._enqueue(event[0], event[1])

    # ── Helpers ───────────────────────────────────────────────────────
    def get_lightweight_state(self):
        """
        Kembalikan state minimal yang dibutuhkan GameLoop untuk overlay.
        Lock sesingkat mungkin, tidak ada deep copy.
        """
        with self._lock:
            return {
                "state":   self._state,
                "cd_start":self._countdown_start,
                "teams":   {k: {"name":v["name"],"color":v["color"]}
                            for k, v in self._team_info.items()},
                "n_teams": len(self._team_info),
            }


game = GameState()


# ══════════════════════════════════════════════════════════════════════
#  GAME LOOP — tidak pernah menyentuh game._lock secara langsung
# ══════════════════════════════════════════════════════════════════════

class GameLoop(threading.Thread):

    def __init__(self):
        super().__init__(daemon=True, name="GameLoop")
        self._stop_flag = threading.Event()   # BUKAN _stop — itu method internal Thread

    def stop(self): self._stop_flag.set()

    def run(self):
        if not CV2_AVAILABLE:
            print("[GAME] OpenCV tidak tersedia.")
            return

        mp_hands = mp.solutions.hands

        cam_idx = game.get_settings().get("camera_index", 0)
        cap = cv2.VideoCapture(cam_idx)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH,  OUT_W)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, OUT_H)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        if not cap.isOpened():
            print(f"[GAME] Kamera {cam_idx} tidak bisa dibuka.")
            return

        hands = mp_hands.Hands(
            static_image_mode=False,
            max_num_hands=4,
            model_complexity=0,
            min_detection_confidence=0.6,
            min_tracking_confidence=0.5,
        )

        with game._lock:
            game._camera_active = True

        print(f"[GAME] Camera loop started (cam={cam_idx}, "
              f"proc={MP_PROC_W}×{MP_PROC_H}, out={OUT_W}×{OUT_H})")

        encode_params = [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY]

        # Finger smoothing per tim: deque dari N terakhir
        finger_history = defaultdict(lambda: deque(maxlen=FINGER_STABLE_FRAMES))

        # Lightweight state cache (refresh tiap 300ms — tanpa lock besar)
        lw_state     = game.get_lightweight_state()
        lw_state_ts  = time.monotonic()
        LW_TTL       = 0.3

        frame_count  = 0
        fps_ts       = time.monotonic()

        while not self._stop_flag.is_set() and cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                time.sleep(0.005)
                continue

            frame  = cv2.flip(frame, 1)
            H, W   = frame.shape[:2]

            # Downscale untuk MediaPipe
            small     = cv2.resize(frame, (MP_PROC_W, MP_PROC_H), cv2.INTER_LINEAR)
            rgb_small = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
            results   = hands.process(rgb_small)

            # Refresh lightweight state jika sudah kedaluwarsa
            now_mono = time.monotonic()
            if now_mono - lw_state_ts > LW_TTL:
                lw_state    = game.get_lightweight_state()
                lw_state_ts = now_mono

            n_teams = lw_state["n_teams"]
            teams   = lw_state["teams"]

            # Reset history jika tidak ada tangan terdeteksi
            detected_teams = set()

            if results.multi_hand_landmarks and results.multi_handedness:
                for hl, handedness in zip(results.multi_hand_landmarks,
                                          results.multi_handedness):
                    wrist_x    = hl.landmark[0].x
                    hand_label = handedness.classification[0].label

                    zone_idx = min(int(wrist_x * n_teams), max(n_teams - 1, 0))
                    team_id  = f"T{zone_idx + 1}"
                    raw_f    = _count_fingers(hl, hand_label)

                    # Smoothing: ambil nilai modus dari N frame terakhir
                    hist = finger_history[team_id]
                    hist.append(raw_f)
                    stable_f = _mode(hist)

                    detected_teams.add(team_id)

                    if stable_f > 0:
                        game.update_gesture(team_id, stable_f)

                    # Overlay skeleton tangan
                    info = teams.get(team_id, {})
                    _draw_hand_overlay(frame, hl, info, stable_f, W, H, mp_hands)

            # Reset tim yang tidak terdeteksi agar tidak stuck
            for tid in list(finger_history.keys()):
                if tid not in detected_teams:
                    finger_history[tid].clear()
                    game.update_gesture(tid, 0)

            # Overlay UI
            _draw_zone_dividers(frame, n_teams, teams, W, H)
            _draw_state_overlay(frame, W, H, lw_state)
            _draw_gesture_status(frame, W, H, lw_state)

            # Encode & push
            ok, buf = cv2.imencode(".jpg", frame, encode_params)
            if ok:
                frame_buffer.write(buf.tobytes())

            # Tick state machine
            game.tick()

            # FPS log
            frame_count += 1
            if frame_count >= 150:
                elapsed    = time.monotonic() - fps_ts
                print(f"[GAME] ~{150/elapsed:.1f} FPS")
                fps_ts     = time.monotonic()
                frame_count= 0

        cap.release()
        hands.close()
        with game._lock:
            game._camera_active = False
        print("[GAME] Camera loop stopped.")


# ══════════════════════════════════════════════════════════════════════
#  HELPER FUNCTIONS
# ══════════════════════════════════════════════════════════════════════

def _mode(seq):
    """Modus dari sequence (nilai yang paling sering muncul)."""
    if not seq: return 0
    counts = {}
    for v in seq:
        counts[v] = counts.get(v, 0) + 1
    return max(counts, key=counts.get)

def _count_fingers(hand_landmarks, hand_label: str) -> int:
    lm = hand_landmarks.landmark
    count = 0
    
    # Ibu jari dicek berdasarkan posisi horizontal (x)
    if hand_label == "Right":
        if lm[4].x < lm[3].x: count += 1  # Jika ujung ibu jari lebih kiri dari sendi
    else:
        if lm[4].x > lm[3].x: count += 1  # Untuk tangan kiri logikanya dibalik
        
    for tip, pip in zip([8,12,16,20], [6,10,14,18]):
        if lm[tip].y < lm[pip].y:
            count += 1
    return count

def _hex_to_bgr(hex_color: str):
    try:
        h = hex_color.lstrip('#')
        r,g,b = int(h[0:2],16), int(h[2:4],16), int(h[4:6],16)
        return (b,g,r)
    except Exception:
        return (0,200,200)

def _draw_hand_overlay(frame, hand_landmarks, team_info: dict,
                       fingers: int, W: int, H: int, mp_hands):
    color = _hex_to_bgr(team_info.get("color","#00FFCC"))
    lm = hand_landmarks.landmark

    for a, b in mp_hands.HAND_CONNECTIONS:
        x1,y1 = int(lm[a].x*W), int(lm[a].y*H)
        x2,y2 = int(lm[b].x*W), int(lm[b].y*H)
        cv2.line(frame,(x1,y1),(x2,y2),color,2,cv2.LINE_AA)

    for tip_idx in [4,8,12,16,20]:
        tx,ty = int(lm[tip_idx].x*W), int(lm[tip_idx].y*H)
        cv2.circle(frame,(tx,ty),5,color,-1,cv2.LINE_AA)

    cx = int(lm[0].x*W)
    cy = max(int(lm[0].y*H) - 20, 20)
    name  = team_info.get("name","")
    label = f"{name}: {ANSWER_LABELS.get(fingers,str(fingers))}"
    cv2.putText(frame,label,(cx-30,cy),cv2.FONT_HERSHEY_SIMPLEX,0.55,(0,0,0),3,cv2.LINE_AA)
    cv2.putText(frame,label,(cx-30,cy),cv2.FONT_HERSHEY_SIMPLEX,0.55,color,1,cv2.LINE_AA)

def _draw_zone_dividers(frame, n_teams:int, teams:dict, W:int, H:int):
    if n_teams < 2: return
    zone_w = W // n_teams
    for i in range(1, n_teams):
        cv2.line(frame,(zone_w*i,0),(zone_w*i,H),(100,100,100),1,cv2.LINE_AA)
    for i in range(n_teams):
        tid   = f"T{i+1}"
        info  = teams.get(tid,{})
        name  = info.get("name",tid)
        color = _hex_to_bgr(info.get("color","#888888"))
        tx    = zone_w*i + 10
        cv2.putText(frame,name,(tx,H-12),cv2.FONT_HERSHEY_SIMPLEX,0.5,(0,0,0),3,cv2.LINE_AA)
        cv2.putText(frame,name,(tx,H-12),cv2.FONT_HERSHEY_SIMPLEX,0.5,color,1,cv2.LINE_AA)

def _draw_state_overlay(frame, W:int, H:int, lw_state:dict):
    # Countdown ditampilkan oleh web popup — tidak digambar di frame kamera
    # agar tidak double dengan overlay browser
    state = lw_state.get("state","")
    if state == "RESULT":
        # Tampilkan teks HASIL kecil di sudut kiri atas saja
        cv2.putText(frame,"HASIL",(10,28),cv2.FONT_HERSHEY_SIMPLEX,
                    0.65,(0,0,0),4,cv2.LINE_AA)
        cv2.putText(frame,"HASIL",(10,28),cv2.FONT_HERSHEY_SIMPLEX,
                    0.65,(72,187,120),2,cv2.LINE_AA)

def _draw_gesture_status(frame, W:int, H:int, lw_state:dict):
    """Tampilkan status kunci jawaban per tim di sudut frame."""
    snap = game.snapshot()
    gesture = snap.get("gesture",{})
    teams   = lw_state.get("teams",{})
    n       = lw_state.get("n_teams",0)
    zone_w  = W // max(n,1)
    lock_dur= snap.get("lock_duration", LOCK_DURATION)

    for i, (tid, info) in enumerate(teams.items()):
        gs    = gesture.get(tid,{})
        color = _hex_to_bgr(info.get("color","#888888"))
        cx    = zone_w * i + zone_w // 2

        if gs.get("locked"):
            ans = ANSWER_LABELS.get(gs.get("answer",0),"?")
            label = f"TERKUNCI: {ans}"
            cv2.putText(frame,label,(cx-60,50),cv2.FONT_HERSHEY_SIMPLEX,
                        0.7,(0,0,0),4,cv2.LINE_AA)
            cv2.putText(frame,label,(cx-60,50),cv2.FONT_HERSHEY_SIMPLEX,
                        0.7,color,2,cv2.LINE_AA)
        elif gs.get("fingers",0) > 0 and gs.get("start_time"):
            elapsed  = time.time() - gs["start_time"]
            progress = min(elapsed / lock_dur, 1.0)
            bar_w    = zone_w - 20
            bar_x    = zone_w * i + 10
            # Progress bar di bagian atas frame
            cv2.rectangle(frame,(bar_x,8),(bar_x+bar_w,20),(50,50,50),-1)
            cv2.rectangle(frame,(bar_x,8),(bar_x+int(bar_w*progress),20),color,-1)
            pct_txt = f"{int(progress*100)}%"
            cv2.putText(frame,pct_txt,(cx-15,18),cv2.FONT_HERSHEY_SIMPLEX,
                        0.4,(255,255,255),1,cv2.LINE_AA)


# ══════════════════════════════════════════════════════════════════════
#  GAME LOOP MANAGEMENT
# ══════════════════════════════════════════════════════════════════════

_game_loop: GameLoop | None = None
_loop_lock = threading.Lock()

def start_game_loop():
    global _game_loop
    with _loop_lock:
        if _game_loop and _game_loop.is_alive():
            return False
        _game_loop = GameLoop()
        _game_loop.start()
    return True

def stop_game_loop():
    global _game_loop
    loop_to_stop = None
    with _loop_lock:
        if _game_loop:
            loop_to_stop = _game_loop
            _game_loop = None
    # join() di LUAR lock agar tidak deadlock
    if loop_to_stop:
        try:
            loop_to_stop.stop()
            loop_to_stop.join(timeout=2)
        except Exception as e:
            print(f"[GAME] stop_game_loop warning: {e}")

def background_tick():
    """Jalankan tick hanya jika kamera mati."""
    while True:
        try:
            with game._lock:
                cam_on = game._camera_active
                st     = game._state
            if not cam_on and st not in ("IDLE","DASHBOARD"):
                game.tick()
        except Exception as e:
            print(f"[BG_TICK] {e}")
        time.sleep(0.1)

threading.Thread(target=background_tick, daemon=True, name="BgTick").start()


# ══════════════════════════════════════════════════════════════════════
#  FLASK APPLICATION
# ══════════════════════════════════════════════════════════════════════

app = Flask(__name__, template_folder="templates", static_folder="static")
app.config["SECRET_KEY"] = "gesture-quiz-2025"

# ── SSE ──────────────────────────────────────────────────────────────

@app.route("/api/stream")
def stream():
    def gen():
        last_ts = time.time() - 1
        while True:
            snap   = game.snapshot()
            events = game.pop_events(last_ts)
            if events:
                last_ts = events[-1]["ts"]
            yield f"data: {json.dumps({'state':snap,'events':events})}\n\n"
            time.sleep(0.2)
    return Response(gen(), mimetype="text/event-stream",
                    headers={"Cache-Control":"no-cache","X-Accel-Buffering":"no"})

# ── Video ─────────────────────────────────────────────────────────────

@app.route("/api/video")
def video_feed():
    TARGET_FPS  = 25
    FRAME_DELAY = 1.0 / TARGET_FPS
    def gen():
        last_ts = 0.0
        while True:
            buf, ts = frame_buffer.read()
            if buf and ts > last_ts:
                yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + buf + b"\r\n"
                last_ts = ts
                time.sleep(FRAME_DELAY)
            else:
                time.sleep(0.04)
    return Response(gen(), mimetype="multipart/x-mixed-replace; boundary=frame",
                    headers={"Cache-Control":"no-cache"})

# ── State & Control ───────────────────────────────────────────────────

@app.route("/api/state")
def api_state():
    return jsonify(game.snapshot())

@app.route("/api/session/start", methods=["POST"])
def api_start():
    ok = game.start_session()
    if ok and CV2_AVAILABLE:
        start_game_loop()
    return jsonify({"ok":ok,"message":"Sesi dimulai" if ok else "Sesi sudah berjalan"})

@app.route("/api/session/reset", methods=["POST"])
def api_reset():
    stop_game_loop()
    game.reset_session()
    return jsonify({"ok":True})

@app.route("/api/session/next", methods=["POST"])
def api_next():
    game.force_next()
    return jsonify({"ok":True})

@app.route("/api/session/prev", methods=["POST"])
def api_prev():
    game.force_prev()
    return jsonify({"ok":True})

@app.route("/api/camera/start", methods=["POST"])
def api_cam_start():
    return jsonify({"ok": start_game_loop()})

@app.route("/api/camera/stop", methods=["POST"])
def api_cam_stop():
    stop_game_loop()
    return jsonify({"ok":True})

@app.route("/api/answer/manual", methods=["POST"])
def api_manual_answer():
    data = request.json or {}
    tid  = data.get("team")
    ans  = int(data.get("answer",0))
    if not tid: return jsonify({"ok":False,"error":"team required"}),400
    game.manual_set_answer(tid, ans)
    return jsonify({"ok":True})

@app.route("/api/gesture/simulate", methods=["POST"])
def api_simulate():
    data = request.json or {}
    game.update_gesture(data.get("team",""), int(data.get("fingers",0)))
    return jsonify({"ok":True})

# ── Questions ─────────────────────────────────────────────────────────

@app.route("/api/questions", methods=["GET"])
def api_get_q():
    return jsonify({"questions": game.get_questions()})

@app.route("/api/questions", methods=["POST"])
def api_set_q():
    qs = (request.json or {}).get("questions",[])
    for i,q in enumerate(qs):
        if not q.get("id"): q["id"] = f"q{int(time.time()*1000)}_{i}"
        q.setdefault("skor",10); q.setdefault("kategori","Umum")
        q.setdefault("penjelasan",""); q.setdefault("kunci",1)
    game.set_questions(qs)
    return jsonify({"ok":True,"count":len(qs)})

@app.route("/api/questions/<q_id>", methods=["DELETE"])
def api_del_q(q_id):
    game.set_questions([q for q in game.get_questions() if q.get("id")!=q_id])
    return jsonify({"ok":True})

@app.route("/api/questions/reorder", methods=["POST"])
def api_reorder():
    order = (request.json or {}).get("order",[])
    qs    = {q["id"]:q for q in game.get_questions()}
    game.set_questions([qs[i] for i in order if i in qs])
    return jsonify({"ok":True})

# ── Settings ──────────────────────────────────────────────────────────

@app.route("/api/settings", methods=["GET"])
def api_get_s(): return jsonify(game.get_settings())

@app.route("/api/settings", methods=["POST"])
def api_set_s():
    data = request.json or {}
    if not data:
        return jsonify({"ok": False, "error": "No data received"}), 400
    game.set_settings(data)
    print(f"[SETTINGS] Disimpan: lock={data.get('lock_duration')}, "
          f"result={data.get('result_duration')}, teams={data.get('num_teams')}")
    return jsonify({"ok": True, "saved_keys": list(data.keys())})

# ── Analytics ─────────────────────────────────────────────────────────

@app.route("/api/analytics")
def api_analytics():
    snap  = game.snapshot()
    teams = snap["teams"]
    stats = snap["stats"]
    acc = {t: round(sum(1 for s in stats if s.get(f"correct_{t}"))/len(stats)*100,1)
           if stats else 0 for t in teams}
    hardest = None
    if stats:
        hardest = min(stats,
            key=lambda s: sum(1 for t in teams if s.get(f"correct_{t}"))
        ).get("soal","?")[:60]
    avg_rt = {t: round(sum(v)/len(v),2) if v else 0
              for t,v in snap["response_times"].items()}
    return jsonify({"scores":snap["scores"],"accuracy":acc,"stats":stats,
                    "hardest":hardest,"avg_response_time":avg_rt,
                    "session_id":snap["session_id"]})

# ── Export ────────────────────────────────────────────────────────────

@app.route("/api/export/json")
def api_export():
    snap = game.snapshot()
    data = {"session_id":snap["session_id"],"exported_at":datetime.now().isoformat(),
            "scores":snap["scores"],"teams":snap["teams"],
            "question_stats":snap["stats"],"questions":game.get_questions(),
            "settings":game.get_settings()}
    resp = Response(json.dumps(data,ensure_ascii=False,indent=2),mimetype="application/json")
    resp.headers["Content-Disposition"] = \
        f"attachment; filename=quiz_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    return resp

# ── Debug ─────────────────────────────────────────────────────────────

@app.route("/api/debug")
def api_debug():
    snap = game.snapshot()
    _,fts = frame_buffer.read()
    return jsonify({
        "state":    snap["state"],
        "gesture":  snap["gesture"],
        "frame_age_ms": round((time.monotonic()-fts)*1000,1) if fts else None,
        "camera":   snap["camera_active"],
        "q_index":  snap["q_index"],
        "scores":   snap["scores"],
    })

@app.route("/")
def index(): return render_template("index.html")

# ══════════════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    print("="*60)
    print("  GESTURE-QUIZ AI — Web Server  (v3)")
    print("  http://localhost:5000")
    print("="*60)
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)