'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function writeJsonAtomically(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { flag: 'wx' });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

class JobManager {
  constructor({ file, maxJobs = 60 } = {}) {
    this.file = file;
    this.maxJobs = maxJobs;
    this.jobs = new Map();
    const persisted = readJson(file);
    for (const job of Array.isArray(persisted?.jobs) ? persisted.jobs : []) {
      if (!job?.id) continue;
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'failed';
        job.error = 'O agente foi reiniciado antes de a operação terminar.';
        job.updatedAt = new Date().toISOString();
      }
      this.jobs.set(job.id, job);
    }
    this.persist();
  }

  persist() {
    const jobs = [...this.jobs.values()]
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, this.maxJobs);
    writeJsonAtomically(this.file, { version: 1, updatedAt: new Date().toISOString(), jobs });
  }

  create(type, payload, runner) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const job = {
      id,
      type,
      status: 'queued',
      progress: 0,
      currentStep: null,
      steps: [],
      payload,
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now
    };
    this.jobs.set(id, job);
    this.persist();

    const context = {
      id,
      step: (label, status = 'running', detail = '') => {
        const existing = job.steps.find(item => item.label === label);
        if (existing) {
          existing.status = status;
          existing.detail = detail;
          existing.updatedAt = new Date().toISOString();
        } else {
          job.steps.push({ label, status, detail, updatedAt: new Date().toISOString() });
        }
        job.currentStep = status === 'running' ? label : job.currentStep;
        job.updatedAt = new Date().toISOString();
        this.persist();
      },
      progress: value => {
        const progress = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
        job.progress = Math.max(job.progress, progress);
        job.updatedAt = new Date().toISOString();
        this.persist();
      }
    };

    setImmediate(async () => {
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      job.updatedAt = job.startedAt;
      this.persist();
      try {
        job.result = await runner(context);
        job.status = 'succeeded';
        job.progress = 100;
        job.currentStep = null;
      } catch (error) {
        job.status = 'failed';
        job.error = error?.message || String(error);
        const active = job.steps.find(item => item.status === 'running');
        if (active) {
          active.status = 'failed';
          active.detail = job.error;
          active.updatedAt = new Date().toISOString();
        }
      } finally {
        job.finishedAt = new Date().toISOString();
        job.updatedAt = job.finishedAt;
        this.persist();
      }
    });

    return this.publicJob(job);
  }

  publicJob(job) {
    if (!job) return null;
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      progress: job.progress,
      currentStep: job.currentStep,
      steps: job.steps,
      payload: job.payload,
      result: job.result,
      error: job.error,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      updatedAt: job.updatedAt
    };
  }

  get(id) {
    return this.publicJob(this.jobs.get(id));
  }

  list({ type, limit = 30 } = {}) {
    return [...this.jobs.values()]
      .filter(job => !type || job.type === type)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 30)))
      .map(job => this.publicJob(job));
  }
}

module.exports = { JobManager };
