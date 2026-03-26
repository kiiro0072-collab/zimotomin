from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
import sqlite3, json, hashlib, secrets, os
from pathlib import Path

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

DB = Path(__file__).parent / "points.db"
APP_DIR = Path(__file__).parent / "App"
ADMIN_USERS = {"MATAKU01"}
SESSION_DAYS = 30
bearer = HTTPBearer(auto_error=False)

# ===== DB =====
def get_db():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con

def init_db():
    con = get_db()
    con.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS points (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS opinions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            point_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            text TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (point_id) REFERENCES points(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS views (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            point_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            viewed_at TEXT DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (point_id) REFERENCES points(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS banned_users (
            user_id INTEGER PRIMARY KEY,
            banned_at TEXT DEFAULT (datetime('now','localtime'))
        );
        CREATE TABLE IF NOT EXISTS likes (
            point_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            PRIMARY KEY (point_id, user_id),
            FOREIGN KEY (point_id) REFERENCES points(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS routes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS route_opinions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            route_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            text TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS travel_plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS plan_opinions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            text TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (plan_id) REFERENCES travel_plans(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS feedbacks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            text TEXT NOT NULL,
            score INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );
    """)
    # マイグレーション
    try:
        con.execute("SELECT score FROM feedbacks LIMIT 1")
    except sqlite3.OperationalError:
        con.execute("ALTER TABLE feedbacks ADD COLUMN score INTEGER DEFAULT 0")
    try:
        con.execute("SELECT viewed_at FROM views LIMIT 1")
    except sqlite3.OperationalError:
        con.execute("ALTER TABLE views ADD COLUMN viewed_at TEXT DEFAULT (datetime('now','localtime'))")
    con.commit()
    con.close()

init_db()

# ===== ユーティリティ =====
def hash_pw(pw: str) -> str:
    return hashlib.sha256(pw.encode()).hexdigest()

def get_current_user(cred: HTTPAuthorizationCredentials = Depends(bearer)):
    if not cred:
        return None
    con = get_db()
    row = con.execute(
        """SELECT u.id, u.username FROM sessions s
           JOIN users u ON s.user_id=u.id
           WHERE s.token=? AND datetime(s.created_at) > datetime('now', ?)""",
        (cred.credentials, f"-{SESSION_DAYS} days")
    ).fetchone()
    con.close()
    return dict(row) if row else None

def is_admin(user) -> bool:
    return bool(user and user["username"] in ADMIN_USERS)

def require_user(cred: HTTPAuthorizationCredentials = Depends(bearer)):
    user = get_current_user(cred)
    if not user:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return user

# ===== モデル =====
class AuthIn(BaseModel):
    username: str
    password: str

class PointIn(BaseModel):
    data: dict

class OpinionIn(BaseModel):
    text: str

class FeedbackIn(BaseModel):
    text: str
    score: int = 0

class RouteIn(BaseModel):
    data: dict

class TravelPlanIn(BaseModel):
    data: dict

# ===== 認証 =====
@app.post("/api/register")
def register(body: AuthIn):
    if len(body.username) < 2 or len(body.password) < 4:
        raise HTTPException(400, "ユーザー名は2文字以上、パスワードは4文字以上")
    con = get_db()
    try:
        con.execute("INSERT INTO users (username, password) VALUES (?, ?)", (body.username, hash_pw(body.password)))
        con.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(409, "そのユーザー名は使われています")
    finally:
        con.close()
    return {"ok": True}

@app.post("/api/login")
def login(body: AuthIn):
    con = get_db()
    row = con.execute("SELECT id FROM users WHERE username=? AND password=?", (body.username, hash_pw(body.password))).fetchone()
    if not row:
        con.close()
        raise HTTPException(401, "ユーザー名またはパスワードが違います")
    if con.execute("SELECT 1 FROM banned_users WHERE user_id=?", (row["id"],)).fetchone():
        con.close()
        raise HTTPException(403, "このアカウントはBANされています")
    token = secrets.token_hex(32)
    con.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, row["id"]))
    con.commit(); con.close()
    return {"token": token, "username": body.username}

@app.post("/api/logout")
def logout(cred: HTTPAuthorizationCredentials = Depends(bearer)):
    if cred:
        con = get_db()
        con.execute("DELETE FROM sessions WHERE token=?", (cred.credentials,))
        con.commit(); con.close()
    return {"ok": True}

@app.get("/api/me")
def me(user=Depends(get_current_user)):
    if not user:
        return {"user": None}
    return {"user": {**user, "is_admin": is_admin(user)}}

# ===== ポイント =====
@app.get("/api/points/version")
def points_version():
    con = get_db()
    r = con.execute("SELECT COUNT(*) as cnt, MAX(id) as maxid FROM points").fetchone()
    o = con.execute("SELECT MAX(id) as maxid FROM opinions").fetchone()
    l = con.execute("SELECT COUNT(*) as cnt FROM likes").fetchone()
    v = con.execute("SELECT MAX(id) as maxid FROM views").fetchone()
    con.close()
    return {"v": f"{r['cnt']}-{r['maxid']}-{o['maxid']}-{l['cnt']}-{v['maxid']}"}

@app.get("/api/points")
def list_points(user=Depends(get_current_user)):
    con = get_db()
    rows = con.execute("SELECT p.id, p.user_id, p.data, u.username FROM points p JOIN users u ON p.user_id=u.id").fetchall()
    ops  = con.execute("SELECT o.id, o.point_id, o.text, o.created_at, u.username, o.user_id FROM opinions o JOIN users u ON o.user_id=u.id").fetchall()
    view_rows = con.execute("SELECT point_id, COUNT(*) as cnt FROM views GROUP BY point_id").fetchall()
    like_rows = con.execute("SELECT point_id, COUNT(*) as cnt FROM likes GROUP BY point_id").fetchall()
    my_likes = set()
    if user:
        my_likes = {r["point_id"] for r in con.execute("SELECT point_id FROM likes WHERE user_id=?", (user["id"],)).fetchall()}
    con.close()
    op_map = {}
    for o in ops:
        op_map.setdefault(o["point_id"], []).append({"id": o["id"], "text": o["text"], "username": o["username"], "created_at": o["created_at"], "user_id": o["user_id"]})
    view_map = {r["point_id"]: r["cnt"] for r in view_rows}
    like_map = {r["point_id"]: r["cnt"] for r in like_rows}
    result = []
    for r in rows:
        pt = json.loads(r["data"])
        pt["id"] = r["id"]; pt["owner_id"] = r["user_id"]; pt["owner_name"] = r["username"]
        pt["opinions"] = op_map.get(r["id"], [])
        pt["views"] = view_map.get(r["id"], 0)
        pt["likes"] = like_map.get(r["id"], 0)
        pt["liked"] = r["id"] in my_likes
        result.append(pt)
    return result

@app.post("/api/points")
def add_point(body: PointIn, user=Depends(require_user)):
    con = get_db()
    cur = con.execute("INSERT INTO points (user_id, data) VALUES (?, ?)", (user["id"], json.dumps(body.data)))
    con.commit(); new_id = cur.lastrowid; con.close()
    return {"id": new_id}

@app.put("/api/points/{point_id}")
def update_point(point_id: int, body: PointIn, user=Depends(require_user)):
    con = get_db()
    row = con.execute("SELECT user_id FROM points WHERE id=?", (point_id,)).fetchone()
    if not row: raise HTTPException(404, "Not found")
    if row["user_id"] != user["id"] and not is_admin(user): raise HTTPException(403, "Forbidden")
    con.execute("UPDATE points SET data=? WHERE id=?", (json.dumps(body.data), point_id))
    con.commit(); con.close()
    return {"ok": True}

@app.delete("/api/points/{point_id}")
def delete_point(point_id: int, user=Depends(require_user)):
    con = get_db()
    row = con.execute("SELECT user_id FROM points WHERE id=?", (point_id,)).fetchone()
    if not row: raise HTTPException(404, "Not found")
    if row["user_id"] != user["id"] and not is_admin(user): raise HTTPException(403, "Forbidden")
    con.execute("DELETE FROM opinions WHERE point_id=?", (point_id,))
    con.execute("DELETE FROM points WHERE id=?", (point_id,))
    con.commit(); con.close()
    return {"ok": True}

@app.post("/api/points/{point_id}/view")
def record_view(point_id: int, user=Depends(require_user)):
    con = get_db()
    recent = con.execute(
        "SELECT 1 FROM views WHERE point_id=? AND user_id=? AND viewed_at > datetime('now','localtime','-1 hour')",
        (point_id, user["id"])
    ).fetchone()
    if not recent:
        con.execute("INSERT OR IGNORE INTO views (point_id, user_id) VALUES (?, ?)", (point_id, user["id"]))
        con.commit()
    con.close()
    return {"ok": True}

@app.post("/api/points/{point_id}/like")
def toggle_like(point_id: int, user=Depends(require_user)):
    con = get_db()
    existing = con.execute("SELECT 1 FROM likes WHERE point_id=? AND user_id=?", (point_id, user["id"])).fetchone()
    if existing:
        con.execute("DELETE FROM likes WHERE point_id=? AND user_id=?", (point_id, user["id"]))
    else:
        con.execute("INSERT INTO likes (point_id, user_id) VALUES (?, ?)", (point_id, user["id"]))
    cnt = con.execute("SELECT COUNT(*) as c FROM likes WHERE point_id=?", (point_id,)).fetchone()["c"]
    con.commit(); con.close()
    return {"liked": not existing, "likes": cnt}

@app.post("/api/points/{point_id}/opinions")
def add_opinion(point_id: int, body: OpinionIn, user=Depends(require_user)):
    if not body.text.strip(): raise HTTPException(400, "Empty")
    con = get_db()
    if not con.execute("SELECT id FROM points WHERE id=?", (point_id,)).fetchone(): raise HTTPException(404, "Not found")
    con.execute("INSERT INTO opinions (point_id, user_id, text) VALUES (?, ?, ?)", (point_id, user["id"], body.text.strip()))
    con.commit(); con.close()
    return {"ok": True}

@app.delete("/api/opinions/{opinion_id}")
def delete_opinion(opinion_id: int, user=Depends(require_user)):
    con = get_db()
    row = con.execute("SELECT user_id FROM opinions WHERE id=?", (opinion_id,)).fetchone()
    if not row: raise HTTPException(404, "Not found")
    if row["user_id"] != user["id"] and not is_admin(user): raise HTTPException(403, "Forbidden")
    con.execute("DELETE FROM opinions WHERE id=?", (opinion_id,))
    con.commit(); con.close()
    return {"ok": True}

# ===== ルート =====
@app.get("/api/routes")
def list_routes(user=Depends(get_current_user)):
    con = get_db()
    rows = con.execute("SELECT r.id, r.user_id, r.data, u.username FROM routes r JOIN users u ON r.user_id=u.id").fetchall()
    ops  = con.execute("SELECT o.id, o.route_id, o.text, o.created_at, u.username, o.user_id FROM route_opinions o JOIN users u ON o.user_id=u.id").fetchall()
    con.close()
    op_map = {}
    for o in ops:
        op_map.setdefault(o["route_id"], []).append({"id": o["id"], "text": o["text"], "username": o["username"], "created_at": o["created_at"], "user_id": o["user_id"]})
    result = []
    for r in rows:
        rt = json.loads(r["data"])
        rt["id"] = r["id"]; rt["owner_id"] = r["user_id"]; rt["owner_name"] = r["username"]
        rt["opinions"] = op_map.get(r["id"], [])
        result.append(rt)
    return result

@app.post("/api/routes")
def add_route(body: RouteIn, user=Depends(require_user)):
    con = get_db()
    cur = con.execute("INSERT INTO routes (user_id, data) VALUES (?, ?)", (user["id"], json.dumps(body.data)))
    con.commit(); new_id = cur.lastrowid; con.close()
    return {"id": new_id}

@app.put("/api/routes/{route_id}")
def update_route(route_id: int, body: RouteIn, user=Depends(require_user)):
    con = get_db()
    row = con.execute("SELECT user_id FROM routes WHERE id=?", (route_id,)).fetchone()
    if not row: raise HTTPException(404, "Not found")
    if row["user_id"] != user["id"] and not is_admin(user): raise HTTPException(403, "Forbidden")
    con.execute("UPDATE routes SET data=? WHERE id=?", (json.dumps(body.data), route_id))
    con.commit(); con.close()
    return {"ok": True}

@app.delete("/api/routes/{route_id}")
def delete_route(route_id: int, user=Depends(require_user)):
    con = get_db()
    row = con.execute("SELECT user_id FROM routes WHERE id=?", (route_id,)).fetchone()
    if not row: raise HTTPException(404, "Not found")
    if row["user_id"] != user["id"] and not is_admin(user): raise HTTPException(403, "Forbidden")
    con.execute("DELETE FROM routes WHERE id=?", (route_id,))
    con.commit(); con.close()
    return {"ok": True}

@app.post("/api/routes/{route_id}/opinions")
def add_route_opinion(route_id: int, body: OpinionIn, user=Depends(require_user)):
    if not body.text.strip(): raise HTTPException(400, "Empty")
    con = get_db()
    if not con.execute("SELECT id FROM routes WHERE id=?", (route_id,)).fetchone(): raise HTTPException(404, "Not found")
    con.execute("INSERT INTO route_opinions (route_id, user_id, text) VALUES (?, ?, ?)", (route_id, user["id"], body.text.strip()))
    con.commit(); con.close()
    return {"ok": True}

@app.delete("/api/route_opinions/{opinion_id}")
def delete_route_opinion(opinion_id: int, user=Depends(require_user)):
    con = get_db()
    row = con.execute("SELECT user_id FROM route_opinions WHERE id=?", (opinion_id,)).fetchone()
    if not row: raise HTTPException(404, "Not found")
    if row["user_id"] != user["id"] and not is_admin(user): raise HTTPException(403, "Forbidden")
    con.execute("DELETE FROM route_opinions WHERE id=?", (opinion_id,))
    con.commit(); con.close()
    return {"ok": True}

# ===== 旅行プラン =====
@app.get("/api/travel_plans")
def list_travel_plans(user=Depends(get_current_user)):
    con = get_db()
    rows = con.execute("SELECT t.id, t.user_id, t.data, u.username FROM travel_plans t JOIN users u ON t.user_id=u.id").fetchall()
    ops  = con.execute("SELECT o.id, o.plan_id, o.text, o.created_at, u.username, o.user_id FROM plan_opinions o JOIN users u ON o.user_id=u.id").fetchall()
    con.close()
    op_map = {}
    for o in ops:
        op_map.setdefault(o["plan_id"], []).append({"id": o["id"], "text": o["text"], "username": o["username"], "created_at": o["created_at"], "user_id": o["user_id"]})
    result = []
    for r in rows:
        d = json.loads(r["data"])
        d["id"] = r["id"]; d["owner_id"] = r["user_id"]; d["owner_name"] = r["username"]
        d["opinions"] = op_map.get(r["id"], [])
        result.append(d)
    return result

@app.post("/api/travel_plans")
def add_travel_plan(body: TravelPlanIn, user=Depends(require_user)):
    con = get_db()
    cur = con.execute("INSERT INTO travel_plans (user_id, data) VALUES (?, ?)", (user["id"], json.dumps(body.data)))
    con.commit(); new_id = cur.lastrowid; con.close()
    return {"id": new_id}

@app.put("/api/travel_plans/{plan_id}")
def update_travel_plan(plan_id: int, body: TravelPlanIn, user=Depends(require_user)):
    con = get_db()
    row = con.execute("SELECT user_id FROM travel_plans WHERE id=?", (plan_id,)).fetchone()
    if not row: raise HTTPException(404, "Not found")
    if row["user_id"] != user["id"] and not is_admin(user): raise HTTPException(403, "Forbidden")
    con.execute("UPDATE travel_plans SET data=? WHERE id=?", (json.dumps(body.data), plan_id))
    con.commit(); con.close()
    return {"ok": True}

@app.delete("/api/travel_plans/{plan_id}")
def delete_travel_plan(plan_id: int, user=Depends(require_user)):
    con = get_db()
    row = con.execute("SELECT user_id FROM travel_plans WHERE id=?", (plan_id,)).fetchone()
    if not row: raise HTTPException(404, "Not found")
    if row["user_id"] != user["id"] and not is_admin(user): raise HTTPException(403, "Forbidden")
    con.execute("DELETE FROM travel_plans WHERE id=?", (plan_id,))
    con.commit(); con.close()
    return {"ok": True}

@app.post("/api/travel_plans/{plan_id}/opinions")
def add_plan_opinion(plan_id: int, body: OpinionIn, user=Depends(require_user)):
    if not body.text.strip(): raise HTTPException(400, "Empty")
    con = get_db()
    if not con.execute("SELECT id FROM travel_plans WHERE id=?", (plan_id,)).fetchone(): raise HTTPException(404, "Not found")
    con.execute("INSERT INTO plan_opinions (plan_id, user_id, text) VALUES (?, ?, ?)", (plan_id, user["id"], body.text.strip()))
    con.commit(); con.close()
    return {"ok": True}

@app.delete("/api/plan_opinions/{opinion_id}")
def delete_plan_opinion(opinion_id: int, user=Depends(require_user)):
    con = get_db()
    row = con.execute("SELECT user_id FROM plan_opinions WHERE id=?", (opinion_id,)).fetchone()
    if not row: raise HTTPException(404, "Not found")
    if row["user_id"] != user["id"] and not is_admin(user): raise HTTPException(403, "Forbidden")
    con.execute("DELETE FROM plan_opinions WHERE id=?", (opinion_id,))
    con.commit(); con.close()
    return {"ok": True}

# ===== フィードバック =====
@app.post("/api/feedbacks")
def add_feedback(body: FeedbackIn):
    if not body.text.strip(): raise HTTPException(400, "Empty")
    con = get_db()
    con.execute("INSERT INTO feedbacks (text, score) VALUES (?, ?)", (body.text.strip(), body.score))
    con.commit(); con.close()
    return {"ok": True}

@app.get("/api/feedbacks")
def list_feedbacks(user=Depends(get_current_user)):
    if not is_admin(user): raise HTTPException(403, "Forbidden")
    con = get_db()
    rows = con.execute("SELECT * FROM feedbacks ORDER BY id DESC").fetchall()
    con.close()
    return [dict(r) for r in rows]

@app.delete("/api/feedbacks/{feedback_id}")
def delete_feedback(feedback_id: int, user=Depends(require_user)):
    if not is_admin(user): raise HTTPException(403, "Forbidden")
    con = get_db()
    con.execute("DELETE FROM feedbacks WHERE id=?", (feedback_id,))
    con.commit(); con.close()
    return {"ok": True}

# ===== BAN =====
@app.post("/api/users/{user_id}/ban")
def ban_user(user_id: int, user=Depends(require_user)):
    if not is_admin(user): raise HTTPException(403, "Forbidden")
    con = get_db()
    con.execute("INSERT OR IGNORE INTO banned_users (user_id) VALUES (?)", (user_id,))
    con.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
    con.commit(); con.close()
    return {"ok": True}

@app.delete("/api/users/{user_id}/ban")
def unban_user(user_id: int, user=Depends(require_user)):
    if not is_admin(user): raise HTTPException(403, "Forbidden")
    con = get_db()
    con.execute("DELETE FROM banned_users WHERE user_id=?", (user_id,))
    con.commit(); con.close()
    return {"ok": True}

# ===== 統計・ランキング =====
@app.get("/api/stats")
def get_stats():
    con = get_db()
    visitors = con.execute("SELECT COUNT(DISTINCT user_id) as c FROM sessions").fetchone()["c"]
    users    = con.execute("SELECT COUNT(*) as c FROM users").fetchone()["c"]
    points   = con.execute("SELECT COUNT(*) as c FROM points").fetchone()["c"]
    con.close()
    return {"visitors": visitors, "users": users, "points": points}

@app.get("/api/ranking")
def get_ranking():
    con = get_db()
    rows = con.execute("""
        SELECT u.username, COUNT(p.id) as cnt
        FROM points p JOIN users u ON p.user_id=u.id
        GROUP BY u.id ORDER BY cnt DESC LIMIT 10
    """).fetchall()
    con.close()
    return [{"username": r["username"], "count": r["cnt"]} for r in rows]

# ===== /app2/ → App/ ディレクトリを配信 =====
@app.get("/app2/{file_path:path}")
async def serve_app2(file_path: str):
    if not file_path or file_path == "/":
        file_path = "index.html"
    target = (APP_DIR / file_path).resolve()
    if not str(target).startswith(str(APP_DIR.resolve())):
        raise HTTPException(403, "Forbidden")
    if not target.exists():
        raise HTTPException(404, "Not Found")
    return FileResponse(target)

@app.get("/app2")
async def serve_app2_root():
    return FileResponse(APP_DIR / "index.html")

# ===== 静的ファイル（最後に配置） =====
app.mount("/", StaticFiles(directory=str(Path(__file__).parent), html=True), name="static")
