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
const SHORT = {
  hero: 'Hero',
  offer: 'Offer',
  process: 'How',
  proof: 'Proof',
  founder: 'Founder',
  guarantee: 'Guar.',
  scarcity: 'Spots',
  pricing: 'Pricing',
  final: 'Final'
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

function rangeStart(range) {
  const now = new Date();
  if (range === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start;
  }
  if (range === '7d') return new Date(now.getTime() - 7 * 86400000);
  if (range === '30d') return new Date(now.getTime() - 30 * 86400000);
  return null;
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function summarize(rows, range) {
  const totals = {};
  const reached = {};
  SECTIONS.forEach(function (id) {
    totals[id] = 0;
    reached[id] = 0;
  });
  const pathCounts = {};
  let timeSum = 0;
  let sectionSum = 0;
  let finalCount = 0;
  const buckets = {};

  rows.forEach(function (visit) {
    const seen = new Set(visit.path || []);
    const dwell = visit.dwell || {};
    let visitMs = 0;
    SECTIONS.forEach(function (id) {
      const ms = Number(dwell[id] || 0);
      totals[id] += ms;
      visitMs += ms;
      if (seen.has(id)) reached[id] += 1;
    });
    timeSum += visitMs;
    sectionSum += (visit.path || []).length;
    if (seen.has('final')) finalCount += 1;
    const key = (visit.path || []).join('>');
    if (key) pathCounts[key] = (pathCounts[key] || 0) + 1;

    const when = new Date(visit.createdAt || visit.updatedAt || Date.now());
    const bucket = range === 'today' ? String(when.getHours()).padStart(2, '0') : dayKey(when);
    if (!buckets[bucket]) buckets[bucket] = { visits: 0, ms: 0, sections: 0, finals: 0 };
    buckets[bucket].visits += 1;
    buckets[bucket].ms += visitMs;
    buckets[bucket].sections += (visit.path || []).length;
    if (seen.has('final')) buckets[bucket].finals += 1;
  });

  const visitCount = rows.length;
  const allMs = SECTIONS.reduce(function (sum, id) { return sum + totals[id]; }, 0);
  const sections = SECTIONS.map(function (id) {
    const visitors = reached[id];
    return {
      id: id,
      label: LABELS[id],
      short: SHORT[id],
      totalMs: totals[id],
      share: allMs ? Math.round((totals[id] / allMs) * 1000) / 10 : 0,
      avgMs: visitors ? Math.round(totals[id] / visitors) : 0,
      visitors: visitors,
      reach: visitCount ? Math.round((visitors / visitCount) * 100) : 0
    };
  });
  const paths = Object.keys(pathCounts)
    .map(function (key) {
      const ids = key.split('>');
      return {
        ids: ids,
        path: ids.map(function (id) { return SHORT[id] || id; }),
        count: pathCounts[key],
        share: visitCount ? Math.round((pathCounts[key] / visitCount) * 1000) / 10 : 0
      };
    })
    .sort(function (a, b) { return b.count - a.count; })
    .slice(0, 6);
  const recent = rows
    .slice()
    .sort(function (a, b) { return new Date(b.createdAt || b.updatedAt) - new Date(a.createdAt || a.updatedAt); })
    .slice(0, 20)
    .map(function (visit) {
      const dwell = visit.dwell || {};
      const seen = new Set(visit.path || []);
      const totalMs = SECTIONS.reduce(function (sum, id) { return sum + Number(dwell[id] || 0); }, 0);
      const compact = String(visit.visitId || '').replace(/-/g, '').slice(0, 6);
      return {
        id: 'v_' + compact,
        started: visit.createdAt || visit.updatedAt,
        totalMs: totalMs,
        depth: SECTIONS.map(function (id) { return seen.has(id); }),
        path: (visit.path || []).map(function (id) { return SHORT[id] || id; }),
        times: SECTIONS.map(function (id) { return { label: SHORT[id], ms: Number(dwell[id] || 0) }; })
      };
    });
  const sparkKeys = Object.keys(buckets).sort();
  const spark = {
    visits: sparkKeys.map(function (key) { return buckets[key].visits; }),
    avgMs: sparkKeys.map(function (key) { return buckets[key].visits ? Math.round(buckets[key].ms / buckets[key].visits) : 0; }),
    avgSections: sparkKeys.map(function (key) { return buckets[key].visits ? Math.round((buckets[key].sections / buckets[key].visits) * 10) / 10 : 0; }),
    finalReach: sparkKeys.map(function (key) { return buckets[key].visits ? Math.round((buckets[key].finals / buckets[key].visits) * 100) : 0; })
  };
  return {
    range: range,
    generatedAt: new Date().toISOString(),
    visits: visitCount,
    avgTimeMs: visitCount ? Math.round(timeSum / visitCount) : 0,
    avgSections: visitCount ? Math.round((sectionSum / visitCount) * 10) / 10 : 0,
    finalCount: finalCount,
    finalReach: visitCount ? Math.round((finalCount / visitCount) * 100) : 0,
    totalMs: allMs,
    sections: sections,
    paths: paths,
    recent: recent,
    spark: spark
  };
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
  const range = ['today', '7d', '30d', 'all'].includes(req.query.range) ? req.query.range : '30d';
  const start = rangeStart(range);
  const query = start ? { createdAt: { $gte: start } } : {};
  const rows = await visits.find(query).limit(5000).toArray();
  res.json(summarize(rows, range));
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
