// packages/db — GSD project state mirror tables (stub for Phase 1, expanded in Phase 2).
// Per D-07: cloud DB mirrors ALL GSD project state so users can browse projects when machine is offline.
// Phase 2 daemon sync will populate these tables and expand columns.
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { devices } from './devices.js';

export const projects = pgTable('projects', {
  id:        text('id').primaryKey(),
  deviceId:  text('device_id').references(() => devices.id, { onDelete: 'cascade' }),
  name:      text('name').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const milestones = pgTable('milestones', {
  id:        text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  name:      text('name'),
  status:    text('status'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const phases = pgTable('phases', {
  id:          text('id').primaryKey(),
  milestoneId: text('milestone_id').references(() => milestones.id, { onDelete: 'cascade' }),
  name:        text('name'),
  status:      text('status'),
  createdAt:   timestamp('created_at').notNull().defaultNow(),
});

export const plans = pgTable('plans', {
  id:        text('id').primaryKey(),
  phaseId:   text('phase_id').references(() => phases.id, { onDelete: 'cascade' }),
  name:      text('name'),
  status:    text('status'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const tasks = pgTable('tasks', {
  id:        text('id').primaryKey(),
  planId:    text('plan_id').references(() => plans.id, { onDelete: 'cascade' }),
  name:      text('name'),
  status:    text('status'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
