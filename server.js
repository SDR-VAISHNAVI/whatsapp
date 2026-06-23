const express  = require('express');
const QRCode   = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs   = require('fs');
const path = require('path');
const pino = require('pino');

const app  = express();
app.use(express.json());

const PORT     = process.env.PORT || 3000;

// FIX 1: Credentials must come from environment variables — never hardcoded.
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY env vars are required');
    process.exit(1);
}

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// FIX 2: Per-owner session map — each owner_id gets its own socket and state.
// This replaces the hardcoded SESSION_ID = 1 single-session model so that
// multiple dojo owners can each have their own WhatsApp connection.
const sessions = new Map();
// sessions: Map<owner_id, { sock, ready, qr, connecting }>

function getState(ownerId) {
    if (!sessions.has(ownerId)) {
        sessions.set(ownerId, { sock: null, ready: false, qr: null, connecting: false });
    }
    return sessions.get(ownerId);
}

// ── Session dir per owner ──────────────────────────────────
function sessionDir(ownerId) {
    return path.join('/tmp', `wa-session-${ownerId}`);
}

function ensureSessionDir(ownerId) {
    const dir = sessionDir(ownerId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// ── Supabase session load/save (keyed by owner_id) ────────
// FIX 3: All Supabase queries now use owner_id as the lookup key,
// matching the schema. The `status` column is also written/read
// to match what the schema and session-management logic expects.
async function loadSession(ownerId) {
    const { data, error } = await supabase
        .from('whatsapp_sessions')
        .select('session')
        .eq('owner_id', ownerId)
        .neq('status', 'logged_out')
        .maybeSingle();
    if (error || !data) return;
    try {
        const dir   = ensureSessionDir(ownerId);
        const files = JSON.parse(data.session);
        for (const [file, content] of Object.entries(files)) {
            fs.writeFileSync(path.join(dir, file), JSON.stringify(content));
        }
        console.log(`✅ session loaded for owner ${ownerId}`);
    } catch (e) {
        console.error(`load error (owner ${ownerId}):`, e.message);
    }
}

async function saveSession(ownerId) {
    try {
        const dir = sessionDir(ownerId);
        if (!fs.existsSync(dir)) return;
        const files = {};
        for (const file of fs.readdirSync(dir)) {
            const raw = fs.readFileSync(path.join(dir, file), 'utf8');
            try { files[file] = JSON.parse(raw); } catch { files[file] = raw; }
        }
        const { error } = await supabase.from('whatsapp_sessions').upsert({
            owner_id:   ownerId,
            session:    JSON.stringify(files),
            status:     'active',
            updated_at: new Date().toISOString()
        }, { onConflict: 'owner_id' });
        if (error) throw error;
        console.log(`✅ session saved for owner ${ownerId}`);
    } catch (e) {
        console.error(`save error (owner ${ownerId}):`, e.message);
    }
}

async function clearSession(ownerId) {
    const dir = sessionDir(ownerId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    await supabase.from('whatsapp_sessions').delete().eq('owner_id', ownerId);
}

async function markLoggedOut(ownerId) {
    const dir = sessionDir(ownerId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    try {
        const { error } = await supabase.from('whatsapp_sessions').update({
            status:     'logged_out',
            updated_at: new Date().toISOString()
        }).eq('owner_id', ownerId);
        if (error) throw error;
        console.log(`marked logged_out for owner ${ownerId}`);
    } catch (e) {
        console.error(`markLoggedOut error (owner ${ownerId}):`, e.message);
    }
}

// ── Core connect function (per owner) ─────────────────────
async function connectWhatsApp(ownerId) {
    const state = getState(ownerId);
    if (state.connecting) return;
    state.connecting = true;

    try {
        await loadSession(ownerId);
        const dir = ensureSessionDir(ownerId);

        // Validate creds
        const credsPath = path.join(dir, 'creds.json');
        if (fs.existsSync(credsPath)) {
            try {
                const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                if (!creds.me) {
                    console.log(`incomplete creds for owner ${ownerId} — clearing`);
                    fs.rmSync(dir, { recursive: true, force: true });
                    fs.mkdirSync(dir, { recursive: true });
                }
            } catch {
                console.log(`corrupt creds for owner ${ownerId} — clearing`);
                fs.rmSync(dir, { recursive: true, force: true });
                fs.mkdirSync(dir, { recursive: true });
            }
        }

        const { state: authState, saveCreds } = await useMultiFileAuthState(dir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth:              authState,
            printQRInTerminal: true,
            logger:            pino({ level: 'warn' }),
            browser:           ['BeltBook', 'Chrome', '120.0.0'],
        });

        state.sock = sock;

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            await saveSession(ownerId);
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                state.qr    = await QRCode.toDataURL(qr);
                state.ready = false;
                console.log(`QR generated for owner ${ownerId}`);
            }

            if (connection === 'open') {
                state.ready      = true;
                state.qr         = null;
                state.connecting = false;
                await saveSession(ownerId);
                console.log(`✅ connected for owner ${ownerId}`);
            }

            if (connection === 'close') {
                state.ready      = false;
                state.connecting = false;
                const code = lastDisconnect?.error instanceof Boom
                    ? lastDisconnect.error.output?.statusCode : null;
                const reconnect = code !== DisconnectReason.loggedOut;
                console.log(`closed for owner ${ownerId} (${code}). reconnect=${reconnect}`);
                if (reconnect) {
                    setTimeout(() => connectWhatsApp(ownerId), 5000);
                } else {
                    await markLoggedOut(ownerId);
                    state.qr   = null;
                    state.sock = null;
                    setTimeout(() => connectWhatsApp(ownerId), 5000);
                }
            }
        });

    } catch (err) {
        console.error(`connect error (owner ${ownerId}):`, err.message);
        const state = getState(ownerId);
        state.connecting = false;
        setTimeout(() => connectWhatsApp(ownerId), 10000);
    }
}

// ── Helper: parse & validate owner_id from request ────────
function parseOwnerId(value) {
    const id = parseInt(value, 10);
    if (isNaN(id) || id <= 0) return null;
    return id;
}

// ── ROUTES ────────────────────────────────────────────────

// Status check — called from Flask /api/whatsapp/status
// FIX 4: owner_id is now read from the query param (passed by Flask).
app.get('/status', (req, res) => {
    const ownerId = parseOwnerId(req.query.owner_id);
    if (!ownerId) return res.status(400).json({ error: 'owner_id required' });
    const state = getState(ownerId);
    res.json({ connected: state.ready, has_qr: !!state.qr });
});

// QR data — called from Flask /api/whatsapp/qr
app.get('/qr-data', (req, res) => {
    const ownerId = parseOwnerId(req.query.owner_id);
    if (!ownerId) return res.status(400).json({ error: 'owner_id required' });
    const state = getState(ownerId);
    if (state.ready) return res.json({ connected: true });
    if (!state.qr)   return res.json({ connected: false, qr: null, message: 'Generating QR…' });
    res.json({ connected: false, qr: state.qr });
});

// Connect (start session)
app.post('/connect', (req, res) => {
    const ownerId = parseOwnerId(req.body?.owner_id);
    if (!ownerId) return res.status(400).json({ error: 'owner_id required' });
    const state = getState(ownerId);
    if (!state.ready && !state.connecting) {
        connectWhatsApp(ownerId);
    }
    res.json({ started: true });
});

// Logout (clear session)
app.post('/logout', async (req, res) => {
    const ownerId = parseOwnerId(req.body?.owner_id);
    if (!ownerId) return res.status(400).json({ error: 'owner_id required' });
    const state = getState(ownerId);
    state.ready = false; state.qr = null;
    if (state.sock) {
        try { await state.sock.logout(); } catch {}
        state.sock = null;
    }
    await clearSession(ownerId);
    sessions.delete(ownerId);
    res.json({ success: true });
});

// Send absence messages
// FIX 5: owner_id from request body is now used to look up the correct session.
app.post('/send-absence', async (req, res) => {
    const { students, date, owner_id } = req.body;
    const ownerId = parseOwnerId(owner_id);
    if (!ownerId) return res.status(400).json({ error: 'owner_id required' });

    const state = getState(ownerId);
    if (!state.ready) {
        return res.status(503).json({ error: 'WhatsApp not connected. Scan QR first.' });
    }
    if (!students?.length) {
        return res.json({ success: true, sent: 0, failed: 0, results: [] });
    }

    const results = [];
    for (const student of students) {
        if (!student.phone_number) continue;
        const phone  = String(student.phone_number).replace(/[^0-9]/g, '');
        const number = phone.startsWith('91') ? phone : '91' + phone;
        const jid    = number + '@s.whatsapp.net';
        const msg    =
`🥋 *Belt Book — Absence Alert*

Dear Parent,
Your ward *${student.name}* was absent for today's karate class on *${date}*.

Please ensure regular attendance to maintain belt progression.

Regards,
Dojo Management 🏯`;
        try {
            await state.sock.sendMessage(jid, { text: msg });
            results.push({ name: student.name, status: 'sent' });
            // Randomized 3-5s delay — looks more human, less bot-like to WhatsApp
            const delay = 3000 + Math.floor(Math.random() * 2000);
            await new Promise(r => setTimeout(r, delay));
        } catch (err) {
            results.push({ name: student.name, status: 'failed', error: err.message });
        }
    }
    res.json({
        success: true,
        sent:    results.filter(r => r.status === 'sent').length,
        failed:  results.filter(r => r.status === 'failed').length,
        results
    });
});

// Health
app.get('/', (req, res) => res.json({ service: 'BeltBook WhatsApp', status: 'ok' }));

// ── START ─────────────────────────────────────────────────
app.listen(PORT, async () => {
    console.log(`🌐 WhatsApp service on port ${PORT}`);
    // FIX 6: Auto-reconnect all owners with active (non-logged-out) sessions on boot.
    try {
        const { data, error } = await supabase
            .from('whatsapp_sessions')
            .select('owner_id')
            .neq('status', 'logged_out');
        if (error) throw error;
        if (data && data.length > 0) {
            console.log(`auto-reconnecting ${data.length} owner session(s) on boot`);
            for (const row of data) {
                connectWhatsApp(row.owner_id);
            }
        }
    } catch (e) {
        console.error('auto-reconnect on boot failed:', e.message);
    }
});
