/**
 * tasks.js — the to-do list and the board meeting planner.
 *
 * Same storage shape as workspace.js: one document per user, so no composite
 * indexes and a single round-trip per read.
 *
 *   cs_tasks/{uid}     { tasks: [...] }
 *   cs_meetings/{uid}  { meetings: [...] }
 *
 * What makes these worth having in a CS tool rather than a generic to-do app is
 * `source`: a task can be created *from* a compliance deadline, a meeting
 * checklist item, or a filing, and carries the citation with it.
 */

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getDoc, setDoc, FirebaseError } from '../firebase.js';
import { requireAuth } from '../middleware/auth.js';
import { logEvent } from '../activity.js';
import {
  MEETING_TYPES,
  MEETING_STATUSES,
  timelineFor,
  sanitiseMeeting,
} from '../meetings.js';

const router = Router();

const TASKS = 'cs_tasks';
const MEETINGS = 'cs_meetings';

const MAX_TASKS = 500;
const MAX_MEETINGS = 300;

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    const status = e instanceof FirebaseError ? e.status : 500;
    res.status(status).json({ error: e.message || 'Something went wrong' });
  }
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PRIORITIES = ['low', 'normal', 'high'];

const str = (v, max, fallback = '') =>
  v === undefined || v === null ? fallback : String(v).trim().slice(0, max);

/** Normalise a task, preserving fields the client didn't send. */
function sanitiseTask(input, existing = {}) {
  const priority = PRIORITIES.includes(input?.priority)
    ? input.priority
    : existing.priority || 'normal';
  const done = input?.done === undefined ? !!existing.done : !!input.done;

  return {
    title: str(input?.title, 300, existing.title || ''),
    notes: str(input?.notes, 4000, existing.notes || ''),
    due: ISO_DATE.test(input?.due || '') ? input.due : input?.due === '' ? '' : existing.due || '',
    priority,
    done,
    companyScrip: str(input?.companyScrip, 12, existing.companyScrip || ''),
    companyName: str(input?.companyName, 200, existing.companyName || ''),
    // Provenance: 'compliance:<ruleId>@<due>' | 'meeting:<id>:<itemId>' | 'filing:<newsId>'
    source: str(input?.source, 160, existing.source || ''),
    sourceLabel: str(input?.sourceLabel, 200, existing.sourceLabel || ''),
    // Completion time is set by the server, never trusted from the client.
    completedAt: done
      ? existing.done && existing.completedAt
        ? existing.completedAt
        : new Date().toISOString()
      : '',
  };
}

async function readTasks(req) {
  const doc = await getDoc(TASKS, req.user.uid, req.idToken);
  return Array.isArray(doc?.tasks) ? doc.tasks : [];
}

async function writeTasks(req, tasks) {
  await setDoc(
    TASKS,
    req.user.uid,
    { uid: req.user.uid, tasks: tasks.slice(0, MAX_TASKS), updatedAt: new Date() },
    req.idToken,
  );
}

// --- Tasks -----------------------------------------------------------------

router.get(
  '/tasks',
  requireAuth,
  handle(async (req, res) => {
    res.json({ tasks: await readTasks(req) });
  }),
);

router.post(
  '/tasks',
  requireAuth,
  handle(async (req, res) => {
    const fields = sanitiseTask(req.body);
    if (!fields.title) return res.status(400).json({ error: 'A task title is required' });

    const tasks = await readTasks(req);
    // Creating the same derived task twice is a real risk when it comes from a
    // deadline or a meeting checklist, so a source is treated as idempotent.
    if (fields.source) {
      const dupe = tasks.find((t) => t.source === fields.source && !t.done);
      if (dupe) return res.status(200).json({ task: dupe, tasks, duplicate: true });
    }

    const task = { id: randomUUID(), createdAt: new Date().toISOString(), ...fields };
    const next = [task, ...tasks].slice(0, MAX_TASKS);
    await writeTasks(req, next);
    logEvent(req, 'task.create', { hasSource: !!fields.source });
    res.status(201).json({ task, tasks: next });
  }),
);

router.patch(
  '/tasks/:id',
  requireAuth,
  handle(async (req, res) => {
    const tasks = await readTasks(req);
    const i = tasks.findIndex((t) => t.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'Task not found' });

    const updated = { ...tasks[i], ...sanitiseTask(req.body, tasks[i]) };
    if (!updated.title) return res.status(400).json({ error: 'A task title is required' });

    const next = [...tasks];
    next[i] = updated;
    await writeTasks(req, next);
    if (updated.done && !tasks[i].done) logEvent(req, 'task.complete', {});
    res.json({ task: updated, tasks: next });
  }),
);

router.delete(
  '/tasks/:id',
  requireAuth,
  handle(async (req, res) => {
    const tasks = await readTasks(req);
    const next = tasks.filter((t) => t.id !== req.params.id);
    if (next.length === tasks.length) {
      return res.status(404).json({ error: 'Task not found' });
    }
    await writeTasks(req, next);
    res.json({ tasks: next });
  }),
);

/** Bulk clear of completed tasks — the "tidy up" action. */
router.post(
  '/tasks/clear-completed',
  requireAuth,
  handle(async (req, res) => {
    const tasks = await readTasks(req);
    const next = tasks.filter((t) => !t.done);
    await writeTasks(req, next);
    res.json({ tasks: next, removed: tasks.length - next.length });
  }),
);

// --- Meetings --------------------------------------------------------------

/** Reference data for the meeting form. */
router.get('/meetings/types', requireAuth, (_req, res) => {
  res.json({ types: MEETING_TYPES, statuses: MEETING_STATUSES });
});

async function readMeetings(req) {
  const doc = await getDoc(MEETINGS, req.user.uid, req.idToken);
  return Array.isArray(doc?.meetings) ? doc.meetings : [];
}

async function writeMeetings(req, meetings) {
  await setDoc(
    MEETINGS,
    req.user.uid,
    {
      uid: req.user.uid,
      meetings: meetings.slice(0, MAX_MEETINGS),
      updatedAt: new Date(),
    },
    req.idToken,
  );
}

/** Attach the derived statutory timeline — it's computed, never stored. */
const withTimeline = (m) => ({
  ...m,
  timeline: timelineFor({
    date: m.date,
    type: m.type,
    hasResults: m.hasResults,
    listed: m.listed,
  }),
});

router.get(
  '/meetings',
  requireAuth,
  handle(async (req, res) => {
    const meetings = await readMeetings(req);
    meetings.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    res.json({ meetings: meetings.map(withTimeline) });
  }),
);

router.post(
  '/meetings',
  requireAuth,
  handle(async (req, res) => {
    const fields = sanitiseMeeting(req.body);
    if (!fields.date) return res.status(400).json({ error: 'A meeting date is required' });
    if (!fields.title) {
      const type = MEETING_TYPES.find((t) => t.id === fields.type);
      fields.title = type ? type.label : 'Meeting';
    }

    const meetings = await readMeetings(req);
    const meeting = { id: randomUUID(), createdAt: new Date().toISOString(), ...fields };
    const next = [meeting, ...meetings].slice(0, MAX_MEETINGS);
    await writeMeetings(req, next);
    logEvent(req, 'meeting.create', { type: meeting.type });
    res.status(201).json({ meeting: withTimeline(meeting) });
  }),
);

router.patch(
  '/meetings/:id',
  requireAuth,
  handle(async (req, res) => {
    const meetings = await readMeetings(req);
    const i = meetings.findIndex((m) => m.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'Meeting not found' });

    const updated = { ...meetings[i], ...sanitiseMeeting(req.body, meetings[i]) };
    if (!updated.date) return res.status(400).json({ error: 'A meeting date is required' });

    const next = [...meetings];
    next[i] = updated;
    await writeMeetings(req, next);
    res.json({ meeting: withTimeline(updated) });
  }),
);

router.delete(
  '/meetings/:id',
  requireAuth,
  handle(async (req, res) => {
    const meetings = await readMeetings(req);
    const next = meetings.filter((m) => m.id !== req.params.id);
    if (next.length === meetings.length) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    await writeMeetings(req, next);
    res.json({ ok: true });
  }),
);

/**
 * Preview a timeline without saving — lets the form show the consequences of a
 * date before the user commits to it.
 */
router.get(
  '/meetings/timeline',
  requireAuth,
  handle(async (req, res) => {
    const date = String(req.query.date || '');
    if (!ISO_DATE.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    res.json({
      timeline: timelineFor({
        date,
        type: String(req.query.type || 'board'),
        hasResults: req.query.hasResults === 'true',
        listed: req.query.listed !== 'false',
      }),
    });
  }),
);

export default router;
