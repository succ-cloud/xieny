const path = require('path');
const dns = require('dns');
const express = require('express');
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');
const PAGE = 'The 30-Day Full-Chair Launch.html';
const SECTIONS = ['hero', 'offer', 'process', 'proof', 'founder', 'guarantee', 'scarcity', 'pricing', 'final'];
const LABELS = {
  hero: 'Hero',
  offer: 'The offer',
  process: 'How we work',
  proof: 'Proof',
  founder: 'Founder',
  guarantee: 'Guarantee',
  scarcity: 'Limited spots',
  pricing: 'Pricing',
  final: 'Final call'
};

const app = express();
app.use(express.json({ limit: '32kb' }));

let visits = null;

function allowSection(name) {
  return SECTIONS.includes(name);
}

function cleanPath(pathList) {
  if (!Array.isArray(pathList)) return [];
  const out = [];
  pathList.forEach(function (name) {
    if (allowSection(name) && out.indexOf(name) === -1) out.push(name);
  });
  return out.slice(0, SECTIONS.length);
}

async function record(body) {
  const visitId = String(body.visitId || '');
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(visitId)) {
    const error = new Error('Invalid visit');
    error.status = 400;
    throw error;
  }
  const nextPath = cleanPath(body.path);
  const span = body.span && typeof body.span === 'object' ? body.span : null;
  let durationMs = 0;
  let section = null;
  let spanKey = null;
  if (span) {
    section = span.section;
    durationMs = Number(span.durationMs);
    spanKey = String(span.id || '');
    if (!allowSection(section) || !Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 30 * 60 * 1000) {
      section = null;
    }
    if (!/^[a-zA-Z0-9-]{8,120}$/.test(spanKey)) section = null;
  }

  const now = new Date();
  let visit = await visits.findOne({ visitId: visitId });
  if (!visit) {
    visit = {
      visitId: visitId,
      createdAt: now,
      updatedAt: now,
      path: nextPath,
      dwell: {},
      spanIds: [],
      sequence: []
    };
    try {
      await visits.insertOne(visit);
    } catch (error) {
      if (error.code !== 11000) throw error;
      visit = await visits.findOne({ visitId: visitId });
    }
  }

  const update = { $set: { updatedAt: now } };
  if (nextPath.length >= (visit.path || []).length) update.$set.path = nextPath;
  if (section && !(visit.spanIds || []).includes(spanKey)) {
    update.$inc = {};
    update.$inc['dwell.' + section] = Math.round(durationMs);
    update.$addToSet = { spanIds: spanKey };
    update.$push = { sequence: { section: section, durationMs: Math.round(durationMs), at: now } };
  }
  await visits.updateOne({ visitId: visitId }, update);
}

function summarize(rows) {
  const totals = {};
  const reached = {};
  SECTIONS.forEach(function (id) {
    totals[id] = 0;
    reached[id] = 0;
  });
  const pathCounts = {};
  rows.forEach(function (visit) {
    const seen = new Set(visit.path || []);
    SECTIONS.forEach(function (id) {
      totals[id] += Number((visit.dwell && visit.dwell[id]) || 0);
      if (seen.has(id)) reached[id] += 1;
    });
    const key = (visit.path || []).join('>');
    if (key) pathCounts[key] = (pathCounts[key] || 0) + 1;
  });
  const visitCount = rows.length;
  const sections = SECTIONS.map(function (id) {
    const visitors = reached[id];
    return {
      id: id,
      label: LABELS[id],
      totalMs: totals[id],
      avgMs: visitors ? Math.round(totals[id] / visitors) : 0,
      visitors: visitors,
      reach: visitCount ? Math.round((visitors / visitCount) * 100) : 0
    };
  });
  const paths = Object.keys(pathCounts)
    .map(function (key) {
      return {
        path: key.split('>').map(function (id) { return LABELS[id] || id; }),
        count: pathCounts[key]
      };
    })
    .sort(function (a, b) { return b.count - a.count; })
    .slice(0, 8);
  const recent = rows
    .slice()
    .sort(function (a, b) { return new Date(b.updatedAt) - new Date(a.updatedAt); })
    .slice(0, 12)
    .map(function (visit) {
      const dwell = visit.dwell || {};
      const totalMs = Object.keys(dwell).reduce(function (sum, key) { return sum + Number(dwell[key] || 0); }, 0);
      return {
        id: visit.visitId.slice(0, 8),
        when: visit.updatedAt,
        totalMs: totalMs,
        path: (visit.path || []).map(function (id) { return LABELS[id] || id; })
      };
    });
  return { visits: visitCount, sections: sections, paths: paths, recent: recent };
}

app.post('/api/track', async function (req, res) {
  if (!visits) return res.status(503).json({ error: 'Database not connected yet' });
  try {
    await record(req.body || {});
    res.json({ ok: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not save visit' });
  }
});

app.get('/api/stats', async function (req, res) {
  if (!visits) return res.status(503).json({ error: 'Add your MongoDB link to the .env file, then restart the server.' });
  const rows = await visits.find({}).limit(5000).toArray();
  res.json(summarize(rows));
});

app.get('/dashboard', function (req, res) {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.use(express.static(ROOT));
app.get('/', function (req, res) {
  res.sendFile(path.join(ROOT, PAGE));
});

async function start() {
  const uri = process.env.MONGODB_URI;
  if (uri) {
    let client = new MongoClient(uri);
    try {
      await client.connect();
    } catch (error) {
      if (error.syscall !== 'querySrv') throw error;
      dns.setServers(['8.8.8.8', '1.1.1.1']);
      client = new MongoClient(uri);
      await client.connect();
    }
    const db = client.db(process.env.MONGODB_DB || 'xieny');
    visits = db.collection('visits');
    await visits.createIndex({ visitId: 1 }, { unique: true });
    console.log('Connected to MongoDB');
  } else {
    console.log('MONGODB_URI is not set. Add it to .env and restart.');
  }
  app.listen(PORT, '0.0.0.0', function () {
    console.log('Site: http://localhost:' + PORT);
    console.log('Charts: http://localhost:' + PORT + '/dashboard');
  });
}

start().catch(function (error) {
  console.error(error);
  process.exit(1);
});
