import { cleanText, fail, isRecord, json, MAX_PROJECTS, readJSON, readJSONBody, requireSameOrigin, uid, writeJSON } from './common.js';

const OWNER = 'owner';
const INDEX_KEY = `owner:${OWNER}:projects:v1`;

export function validProjectId(id) {
  return typeof id === 'string' && /^[a-f0-9]{24}$/.test(id);
}

export async function getProject(env, id) {
  if (!validProjectId(id)) fail(400, 'invalid_project_id', 'The project ID is invalid.');
  const project = await readJSON(env, `project:${OWNER}:${id}`);
  if (!project) fail(404, 'project_not_found', 'This project does not exist or has been deleted.');
  return project;
}

export async function listProjects(env) {
  const index = await readJSON(env, INDEX_KEY) || [];
  const projects = [];
  for (const id of index.slice(0, MAX_PROJECTS)) {
    const project = await readJSON(env, `project:${OWNER}:${id}`);
    if (project) projects.push(project);
  }
  return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createProject(request, env) {
  requireSameOrigin(request);
  const body = await readJSONBody(request);
  const current = await readJSON(env, INDEX_KEY) || [];
  if (current.length >= MAX_PROJECTS) fail(409, 'project_limit_reached', `A maximum of ${MAX_PROJECTS} projects is supported in this free-tier configuration.`);
  const id = uid();
  const now = new Date().toISOString();
  const project = {
    schemaVersion: 1,
    id,
    name: cleanText(body.name || 'Untitled project', 80, 'Project name', false),
    description: cleanText(body.description, 1000, 'Description'),
    objective: cleanText(body.objective, 1000, 'Objective'),
    audience: cleanText(body.audience, 500, 'Audience'),
    channels: normalizeChannels(body.channels),
    brandInstructions: cleanText(body.brandInstructions, 1200, 'Brand instructions'),
    templates: [],
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
  await writeJSON(env, `project:${OWNER}:${id}`, project);
  await writeJSON(env, INDEX_KEY, [id, ...current].slice(0, MAX_PROJECTS));
  return json({ project }, 201);
}

function normalizeChannels(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(400, 'invalid_channels', 'Channels must be a list.');
  return value.slice(0, 12).map((channel) => cleanText(channel, 40, 'Channel', false));
}

function normalizeTemplates(value) {
  if (!Array.isArray(value) || value.length > 20) fail(400, 'invalid_templates', 'Provide up to 20 prompt templates.');
  return value.map((item) => {
    if (!isRecord(item)) fail(400, 'invalid_template', 'Each prompt template must be an object.');
    return {
      id: cleanText(item.id || uid(), 40, 'Template ID', false),
      name: cleanText(item.name, 80, 'Template name', false),
      prompt: cleanText(item.prompt, 1500, 'Template prompt', false),
    };
  });
}

export async function updateProject(request, env, id) {
  requireSameOrigin(request);
  const body = await readJSONBody(request);
  const current = await getProject(env, id);
  const next = { ...current, updatedAt: new Date().toISOString() };
  const limits = { name: 80, description: 1000, objective: 1000, audience: 500, brandInstructions: 1200 };
  for (const [field, limit] of Object.entries(limits)) {
    if (field in body) next[field] = cleanText(body[field], limit, field, field !== 'name');
  }
  if ('channels' in body) next.channels = normalizeChannels(body.channels);
  if ('templates' in body) next.templates = normalizeTemplates(body.templates);
  if ('archived' in body) next.archived = Boolean(body.archived);
  await writeJSON(env, `project:${OWNER}:${id}`, next);
  return json({ project: next });
}

export async function deleteProject(request, env, id) {
  requireSameOrigin(request);
  const project = await getProject(env, id);
  const index = await readJSON(env, INDEX_KEY) || [];
  await env.METADATA.delete(`project:${OWNER}:${id}`);
  await writeJSON(env, INDEX_KEY, index.filter((value) => value !== id));
  return json({ deleted: true, projectId: project.id });
}
