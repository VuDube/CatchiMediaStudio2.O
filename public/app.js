(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = { projects: [], jobs: [], assets: [], localAssets: [], selectedProjectId: '', contentJobId: '', projectTemplates: [], theme: 'dark', assemblyAudio: null };
  const viewNames = { dashboard: 'Overview', projects: 'Projects', content: 'Content studio', image: 'Image studio', audio: 'Audio studio', video: 'Video studio', library: 'Asset library', operations: 'Operations' };
  let dbPromise;
  let pollTimer = null;
  let activeObjectUrls = [];

  function message(id, text, type = '') {
    const node = document.getElementById(id);
    if (!node) return;
    node.textContent = text || '';
    node.className = `form-message${type ? ` ${type}` : ''}`;
  }
  function toast(text, type = '') {
    const region = $('#toast-region');
    const node = document.createElement('div');
    node.className = `toast${type ? ` ${type}` : ''}`;
    node.textContent = text;
    region.append(node);
    setTimeout(() => node.remove(), 4500);
  }
  function objectUrl(blob) {
    const url = URL.createObjectURL(blob);
    activeObjectUrls.push(url);
    return url;
  }
  function revokeUrls() {
    for (const url of activeObjectUrls) URL.revokeObjectURL(url);
    activeObjectUrls = [];
  }
  function newId() { return crypto.randomUUID().replaceAll('-', '').slice(0, 24); }
  function fmtDate(value) {
    try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
    catch { return 'Unknown date'; }
  }
  function fmtBytes(bytes = 0) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  function option(text, value) {
    const node = document.createElement('option');
    node.textContent = text;
    node.value = value;
    return node;
  }
  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options, headers: { Accept: 'application/json', ...(options.headers || {}) } });
    let body;
    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.includes('application/json')) body = await response.json();
    else body = { message: await response.text() };
    if (!response.ok) {
      if (response.status === 401 && path !== '/api/auth/login') showSignedOut('Your session expired. Sign in again.');
      const error = new Error(body.message || `Request failed (${response.status}).`);
      error.status = response.status;
      error.code = body.error;
      throw error;
    }
    return body;
  }
  function jsonOptions(method, body, extraHeaders = {}) {
    return { method, headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) };
  }
  function setBusy(button, busy, label) {
    if (!button) return;
    button.disabled = busy;
    if (busy) { button.dataset.label = button.textContent; button.textContent = label || 'Working…'; }
    else if (button.dataset.label) { button.textContent = button.dataset.label; delete button.dataset.label; }
  }
  function showSignedOut(reason = '') {
    clearTimeout(pollTimer);
    $('#workspace').hidden = true;
    $('#signin-screen').hidden = false;
    $('#signin-password').value = '';
    $('#signin-password').focus({ preventScroll: true });
    message('signin-error', reason);
  }
  function showWorkspace() {
    $('#signin-screen').hidden = true;
    $('#workspace').hidden = false;
  }
  function showView(view) {
    if (!viewNames[view]) return;
    for (const panel of $$('[data-view-panel]')) {
      const active = panel.dataset.viewPanel === view;
      panel.hidden = !active;
      panel.classList.toggle('active', active);
    }
    for (const nav of $$('.nav-item[data-view]')) nav.classList.toggle('active', nav.dataset.view === view);
    $('#current-view-name').textContent = viewNames[view];
    $('#sidebar').classList.remove('open');
    $('#menu-toggle').setAttribute('aria-expanded', 'false');
    location.hash = view;
    if (view === 'library') refreshLibrary();
    if (view === 'operations') refreshOperations();
  }
  function updateConnection() {
    const online = navigator.onLine;
    $('#connection-label').textContent = online ? 'Connected' : 'Offline';
    $('#connection-dot').className = `status-dot ${online ? 'good' : 'warn'}`;
    $('#network-banner').hidden = online;
  }

  function openDB() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('This browser does not support local media storage.'));
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('catchi-media-local', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open browser media storage.'));
    });
    return dbPromise;
  }
  async function idbRequest(mode, callback) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('assets', mode);
      const store = tx.objectStore('assets');
      const request = callback(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Browser storage operation failed.'));
      tx.onerror = () => reject(tx.error || new Error('Browser storage transaction failed.'));
    });
  }
  async function localGetAll() {
    try { return (await idbRequest('readonly', (store) => store.getAll())) || []; }
    catch { return []; }
  }
  async function localGet(id) {
    try { return await idbRequest('readonly', (store) => store.get(id)); }
    catch { return null; }
  }
  async function localDelete(id) {
    try { await idbRequest('readwrite', (store) => store.delete(id)); }
    catch (error) { toast(error.message || 'Could not remove the local file.', 'error'); }
  }
  async function saveLocalAsset(meta, blob, localOnly = false) {
    if (!(blob instanceof Blob) || blob.size === 0) return false;
    if (blob.size > 100 * 1024 * 1024) return false;
    try {
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        if (estimate.quota && estimate.usage / estimate.quota > 0.92) throw new Error('Browser storage is nearly full.');
      }
      await idbRequest('readwrite', (store) => store.put({
        id: meta.id,
        type: meta.type,
        title: meta.title || 'Untitled asset',
        mimeType: meta.mimeType || blob.type || 'application/octet-stream',
        sizeBytes: blob.size,
        createdAt: meta.createdAt || new Date().toISOString(),
        projectId: meta.projectId || null,
        provider: meta.provider || (localOnly ? 'Browser upload' : 'cloudflare-workers-ai'),
        model: meta.model || (localOnly ? 'Local file' : ''),
        prompt: meta.prompt || '',
        localOnly,
        blob,
      }));
      state.localAssets = await localGetAll();
      return true;
    } catch (error) {
      console.warn('Local media retention failed:', error?.name || 'Error');
      return false;
    }
  }
  function dataUrlToBlob(dataUrl) {
    return fetch(dataUrl).then((response) => response.blob());
  }

  async function loadHealth() {
    const health = await api('/api/health');
    const strip = $('#capability-strip');
    strip.replaceChildren();
    const values = [
      ['Text', health.capabilities.textGeneration.enabled ? 'Queued · Llama 3.1' : 'Unavailable'],
      ['Images', health.capabilities.imageGeneration.enabled ? 'FLUX.1 schnell' : 'Unavailable'],
      ['Audio', health.capabilities.speechGeneration.enabled && health.capabilities.transcription.enabled ? 'MeloTTS + Whisper' : 'Partially unavailable'],
      ['Video', 'Planning + browser assembly'],
    ];
    for (const [title, desc] of values) {
      const card = document.createElement('div'); card.className = 'capability-card';
      const small = document.createElement('span'); small.textContent = 'AVAILABLE CAPABILITY';
      const strong = document.createElement('strong'); strong.textContent = title;
      const text = document.createElement('span'); text.textContent = desc;
      card.append(small, strong, text); strip.append(card);
    }
    return health;
  }

  async function loadProjects() {
    const result = await api('/api/projects');
    state.projects = result.projects || [];
    state.selectedProjectId = state.selectedProjectId && state.projects.some((p) => p.id === state.selectedProjectId) ? state.selectedProjectId : (state.projects[0]?.id || '');
    renderProjects();
    updateProjectSelectors();
    return state.projects;
  }
  function renderProjects() {
    $('#project-count').textContent = String(state.projects.length);
    $('#metric-projects').textContent = String(state.projects.filter((p) => !p.archived).length);
    const list = $('#project-list'); list.replaceChildren();
    const recent = $('#dashboard-projects'); recent.replaceChildren();
    if (!state.projects.length) {
      list.append(empty('No projects yet. Create a project to save objectives and brand instructions.'));
      recent.append(empty('Create a project to organize your work.'));
    }
    for (const project of state.projects) {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'list-row project-row'; row.setAttribute('aria-label', `Open project ${project.name}`);
      const main = document.createElement('span'); main.className = 'list-main';
      const title = document.createElement('strong'); title.textContent = project.name;
      const detail = document.createElement('small'); detail.textContent = `${project.archived ? 'Archived · ' : ''}${project.objective || project.description || 'No objective yet'}`;
      main.append(title, detail); row.append(main); row.addEventListener('click', () => openProject(project)); list.append(row);
      if (!project.archived) {
        const compact = document.createElement('button'); compact.type = 'button'; compact.className = 'list-row';
        const cmain = document.createElement('span'); cmain.className = 'list-main'; const ct = document.createElement('strong'); ct.textContent = project.name; const cd = document.createElement('small'); cd.textContent = project.objective || 'Project workspace'; cmain.append(ct, cd); compact.append(cmain); compact.addEventListener('click', () => openProject(project)); recent.append(compact);
      }
    }
    renderProjectTemplates();
  }
  function empty(text) { const div = document.createElement('div'); div.className = 'empty-state'; div.textContent = text; return div; }
  function updateProjectSelectors() {
    for (const id of ['content-project', 'image-project', 'speech-project', 'transcribe-project', 'library-project']) {
      const select = document.getElementById(id); if (!select) continue;
      const prior = select.value; select.replaceChildren(option(id === 'library-project' ? 'All projects' : 'No project', ''));
      for (const project of state.projects) {
        const opt = option(`${project.name}${project.archived ? ' · archived' : ''}`, project.id); select.append(opt);
      }
      if ([...select.options].some((o) => o.value === prior)) select.value = prior;
      else if (id !== 'library-project' && state.selectedProjectId) select.value = state.selectedProjectId;
    }
    renderProjectTemplates();
  }
  function clearProjectForm() {
    $('#project-id').value = ''; $('#project-name').value = ''; $('#project-description').value = ''; $('#project-objective').value = ''; $('#project-audience').value = ''; $('#project-channels').value = ''; $('#project-brand').value = '';
    $('#project-form-title').textContent = 'Create a project'; $('#save-project-button').textContent = 'Create project'; $('#archive-project-button').hidden = true; $('#delete-project-button').hidden = true; $('#project-save-state').textContent = '';
    state.projectTemplates = []; renderProjectTemplateEditor(); message('project-message', '');
  }
  function openProject(project) {
    state.selectedProjectId = project.id; $('#project-id').value = project.id; $('#project-name').value = project.name; $('#project-description').value = project.description || ''; $('#project-objective').value = project.objective || ''; $('#project-audience').value = project.audience || ''; $('#project-channels').value = (project.channels || []).join(', '); $('#project-brand').value = project.brandInstructions || '';
    $('#project-form-title').textContent = 'Edit project'; $('#save-project-button').textContent = 'Save changes'; $('#archive-project-button').hidden = false; $('#archive-project-button').textContent = project.archived ? 'Restore project' : 'Archive'; $('#delete-project-button').hidden = false;
    state.projectTemplates = [...(project.templates || [])]; renderProjectTemplateEditor(); updateProjectSelectors(); showView('projects');
  }
  function renderProjectTemplateEditor() {
    const container = $('#project-template-list'); if (!container) return; container.replaceChildren();
    for (const [index, template] of state.projectTemplates.entries()) {
      const row = document.createElement('div'); row.className = 'template-chip'; const name = document.createElement('span'); name.textContent = template.name;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove ${template.name} template`); remove.addEventListener('click', () => { state.projectTemplates.splice(index, 1); renderProjectTemplateEditor(); }); row.append(name, remove); container.append(row);
    }
  }
  function renderProjectTemplates() {
    const select = $('#content-template'); if (!select) return; const current = select.value; select.replaceChildren(option('No template selected', ''));
    const project = state.projects.find((p) => p.id === $('#content-project').value);
    for (const template of project?.templates || []) select.append(option(template.name, template.id));
    if ([...select.options].some((o) => o.value === current)) select.value = current;
  }
  $('#content-project').addEventListener('change', renderProjectTemplates);
  $('#content-template').addEventListener('change', () => {
    const project = state.projects.find((p) => p.id === $('#content-project').value);
    const template = project?.templates?.find((t) => t.id === $('#content-template').value);
    if (template) $('#content-prompt').value = template.prompt;
    updateCounts();
  });
  $('#new-project-button').addEventListener('click', () => { clearProjectForm(); $('#project-name').focus(); });
  $('#add-template').addEventListener('click', () => {
    const name = $('#template-name').value.trim(); const prompt = $('#template-prompt').value.trim();
    if (!name || !prompt) { message('project-message', 'Enter both a template name and reusable prompt.', 'error'); return; }
    if (state.projectTemplates.length >= 20) { message('project-message', 'This project can store up to 20 templates.', 'error'); return; }
    state.projectTemplates.push({ id: newId(), name, prompt }); $('#template-name').value = ''; $('#template-prompt').value = ''; renderProjectTemplateEditor(); message('project-message', 'Template added to this draft. Save the project to keep it.', 'success');
  });
  $('#project-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = $('#save-project-button'); setBusy(button, true, 'Saving…'); message('project-message', 'Saving project metadata…');
    const id = $('#project-id').value;
    const channels = $('#project-channels').value.split(',').map((x) => x.trim()).filter(Boolean);
    const body = { name: $('#project-name').value, description: $('#project-description').value, objective: $('#project-objective').value, audience: $('#project-audience').value, channels, brandInstructions: $('#project-brand').value, templates: state.projectTemplates };
    try {
      const result = id ? await api(`/api/projects/${id}`, jsonOptions('PATCH', body)) : await api('/api/projects', jsonOptions('POST', body));
      state.selectedProjectId = result.project.id; await loadProjects(); openProject(result.project); message('project-message', 'Project saved.', 'success'); toast('Project saved.');
    } catch (error) { message('project-message', error.message, 'error'); }
    finally { setBusy(button, false); }
  });
  $('#archive-project-button').addEventListener('click', async () => {
    const id = $('#project-id').value; const project = state.projects.find((p) => p.id === id); if (!project) return;
    try { const result = await api(`/api/projects/${id}`, jsonOptions('PATCH', { archived: !project.archived })); await loadProjects(); openProject(result.project); toast(project.archived ? 'Project restored.' : 'Project archived.'); }
    catch (error) { message('project-message', error.message, 'error'); }
  });
  $('#delete-project-button').addEventListener('click', async () => {
    const id = $('#project-id').value; const project = state.projects.find((p) => p.id === id); if (!project) return;
    if (!confirm(`Delete “${project.name}”? This removes project metadata. Related jobs and saved assets are retained.`)) return;
    try { await api(`/api/projects/${id}`, { method: 'DELETE' }); state.selectedProjectId = ''; await loadProjects(); clearProjectForm(); toast('Project metadata deleted.'); }
    catch (error) { message('project-message', error.message, 'error'); }
  });

  function updateCounts() {
    const pairs = [['content-prompt', 'content-char-count', 2000], ['image-prompt', 'image-char-count', 2048], ['speech-text', 'speech-char-count', 1200]];
    for (const [input, output, max] of pairs) { const node = document.getElementById(input); if (node) document.getElementById(output).textContent = `${node.value.length} / ${max}`; }
  }
  for (const id of ['content-prompt', 'image-prompt', 'speech-text']) document.getElementById(id).addEventListener('input', updateCounts);

  async function refreshJobs() {
    const response = await api('/api/jobs'); state.jobs = response.jobs || [];
    $('#metric-jobs').textContent = String(state.jobs.length);
    renderJobs();
    return state.jobs;
  }
  function renderJobs() {
    const areas = [$('#dashboard-jobs'), $('#failed-jobs')]; for (const area of areas) area.replaceChildren();
    const rows = state.jobs.slice(0, 8);
    if (!rows.length) $('#dashboard-jobs').append(empty('No jobs have been accepted yet. Start a text, image or audio workflow.'));
    for (const job of rows.slice(0, 5)) $('#dashboard-jobs').append(jobListRow(job));
    const failed = state.jobs.filter((job) => job.status === 'failed');
    if (!failed.length) $('#failed-jobs').append(empty('No failed jobs in the recent job window.'));
    else for (const job of failed.slice(0, 8)) $('#failed-jobs').append(jobListRow(job));
    renderJobsTable();
  }
  function jobListRow(job) {
    const row = document.createElement('div'); row.className = 'list-row';
    const main = document.createElement('span'); main.className = 'list-main'; const title = document.createElement('strong'); title.textContent = `${job.mode || job.kind} · ${job.status}`; const detail = document.createElement('small'); detail.textContent = `${fmtDate(job.createdAt)} · ${job.provider || '—'}`; main.append(title, detail);
    const pill = document.createElement('span'); pill.className = `status-pill ${job.status === 'failed' ? 'status-off' : ''}`; pill.textContent = job.status; row.append(main, pill); return row;
  }
  function renderJobsTable() {
    const body = $('#jobs-table'); body.replaceChildren();
    if (!state.jobs.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 6; cell.textContent = 'No jobs recorded.'; row.append(cell); body.append(row); return; }
    for (const job of state.jobs.slice(0, 20)) {
      const row = document.createElement('tr');
      for (const value of [fmtDate(job.createdAt), job.kind, job.status, `${job.provider || '—'} · ${job.model || ''}`, state.projects.find((p) => p.id === job.projectId)?.name || '—']) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
      const actionCell = document.createElement('td');
      if (job.kind === 'text' && ['queued', 'running'].includes(job.status)) { const cancel = document.createElement('button'); cancel.className = 'button secondary'; cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.addEventListener('click', async () => { try { await api(`/api/jobs/${job.id}`, { method: 'DELETE' }); await refreshJobs(); } catch (error) { toast(error.message, 'error'); } }); actionCell.append(cancel); }
      row.append(actionCell); body.append(row);
    }
  }
  $('#content-form').addEventListener('submit', async (event) => {
    event.preventDefault(); clearTimeout(pollTimer);
    const prompt = $('#content-prompt').value.trim(); if (!prompt) { message('content-message', 'Enter a brief before generating.', 'error'); return; }
    const button = $('#content-submit'); setBusy(button, true, 'Submitting…'); message('content-message', 'Submitting a real text job…');
    $('#content-result').value = ''; $('#content-result').disabled = true; $('#copy-content').disabled = true; $('#save-content').disabled = true;
    $('#content-job-status').textContent = 'Submitting'; $('#content-job-detail').textContent = 'Validating the request and accepting it into the background queue.';
    try {
      const idempotency = newId() + newId();
      const result = await api('/api/jobs', jsonOptions('POST', { prompt, mode: $('#content-mode').value, projectId: $('#content-project').value || null }, { 'Idempotency-Key': idempotency }));
      state.contentJobId = result.job.id; $('#content-job-status').textContent = result.job.status; $('#content-job-detail').textContent = `Job ${result.job.id} accepted · ${result.job.model} · ${fmtDate(result.job.createdAt)}`;
      message('content-message', 'Job accepted. Waiting for the actual model result.', 'success'); setBusy(button, false); await refreshJobs(); pollTextJob(result.job.id, 0);
    } catch (error) { message('content-message', error.message, 'error'); $('#content-job-status').textContent = 'Not accepted'; $('#content-job-detail').textContent = 'No successful job was recorded.'; setBusy(button, false); }
  });
  async function pollTextJob(id, attempts) {
    if (attempts > 80 || id !== state.contentJobId) return;
    try {
      const result = await api(`/api/jobs/${id}`); const job = result.job;
      $('#content-job-status').textContent = job.status;
      if (job.status === 'succeeded' && job.result?.text) {
        $('#content-result').disabled = false; $('#content-result').value = job.result.text; $('#copy-content').disabled = false; $('#save-content').disabled = false;
        $('#download-content').href = objectUrl(new Blob([job.result.text], { type: 'text/plain;charset=utf-8' })); $('#download-content').classList.remove('disabled-link'); $('#download-content').removeAttribute('aria-disabled');
        $('#content-job-detail').textContent = `Completed ${fmtDate(job.updatedAt)} · ${job.model} · result validated and stored as private text.`;
        message('content-message', 'The real model result is ready and editable.', 'success'); await refreshJobs(); return;
      }
      if (job.status === 'failed' || job.status === 'cancelled') {
        $('#content-job-detail').textContent = job.error || `Job ${job.status}.`;
        message('content-message', job.error || `Job ${job.status}.`, 'error'); await refreshJobs(); return;
      }
      $('#content-job-detail').textContent = `${job.status === 'running' ? 'The model is processing the accepted job.' : 'The accepted job is waiting in the queue.'} · ${fmtDate(job.createdAt)}`;
      const delay = attempts < 4 ? 1800 : attempts < 12 ? 3500 : 7000;
      pollTimer = setTimeout(() => pollTextJob(id, attempts + 1), delay);
    } catch (error) { $('#content-job-detail').textContent = error.message; message('content-message', error.message, 'error'); }
  }
  $('#copy-content').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#content-result').value); toast('Text copied.'); } catch { toast('Clipboard access was denied.', 'error'); } });
  $('#save-content').addEventListener('click', async () => {
    const content = $('#content-result').value.trim(); if (!content) return;
    setBusy($('#save-content'), true, 'Saving…');
    try { await api('/api/assets/text', jsonOptions('POST', { title: `${$('#content-mode').selectedOptions[0].text} · ${new Date().toLocaleDateString()}`, content, projectId: $('#content-project').value || null, jobId: state.contentJobId, model: '@cf/meta/llama-3.1-8b-instruct-fp8' })); message('content-message', 'Saved to private library metadata and KV text storage.', 'success'); toast('Text saved to library.'); await refreshLibrary(); }
    catch (error) { message('content-message', error.message, 'error'); }
    finally { setBusy($('#save-content'), false); }
  });

  $('#image-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const prompt = $('#image-prompt').value.trim(); if (!prompt) return message('image-message', 'Enter an image prompt.', 'error');
    const button = $('#image-submit'); setBusy(button, true, 'Generating…'); message('image-message', 'Sending a real FLUX.1 schnell inference request…'); $('#image-status').textContent = 'Running';
    try {
      const payload = { prompt, steps: Number($('#image-steps').value), projectId: $('#image-project').value || null };
      if ($('#image-seed').value) payload.seed = Number($('#image-seed').value);
      const result = await api('/api/generate/image', jsonOptions('POST', payload));
      const blob = await dataUrlToBlob(result.dataUrl); const saved = await saveLocalAsset(result.asset, blob);
      const img = document.createElement('img'); img.alt = 'Generated image'; img.src = objectUrl(blob); const preview = $('#image-preview'); preview.replaceChildren(img); preview.classList.remove('empty-preview');
      const link = $('#image-download'); link.href = objectUrl(blob); link.download = `catchi-${result.asset.id}.${result.asset.mimeType === 'image/png' ? 'png' : result.asset.mimeType === 'image/webp' ? 'webp' : 'jpg'}`; link.classList.remove('disabled-link'); link.removeAttribute('aria-disabled');
      $('#image-meta').textContent = `${result.asset.model} · ${result.asset.mimeType} · ${fmtBytes(result.asset.sizeBytes)} · ${fmtDate(result.asset.createdAt)}`;
      $('#image-retention').textContent = saved ? 'Saved in this browser. Download for durable retention.' : 'Browser storage was unavailable; download the file now.';
      $('#image-status').textContent = 'Succeeded'; message('image-message', saved ? 'Real image generated and saved in this browser.' : 'Real image generated. Browser storage failed; use Download image.', saved ? 'success' : ''); await refreshJobs(); await refreshLibrary();
    } catch (error) { $('#image-status').textContent = 'Failed'; message('image-message', error.message, 'error'); }
    finally { setBusy(button, false); }
  });

  $('#speech-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const prompt = $('#speech-text').value.trim(); if (!prompt) return message('speech-message', 'Enter a short narration script.', 'error');
    const button = $('#speech-submit'); setBusy(button, true, 'Generating…'); message('speech-message', 'Generating actual speech with MeloTTS…');
    try {
      const result = await api('/api/generate/speech', jsonOptions('POST', { prompt, language: $('#speech-language').value, projectId: $('#speech-project').value || null }));
      const blob = await dataUrlToBlob(result.dataUrl); const saved = await saveLocalAsset(result.asset, blob); const url = objectUrl(blob);
      $('#speech-player').src = url; $('#speech-download').href = url; $('#speech-download').download = `catchi-${result.asset.id}.mp3`; $('#speech-output').hidden = false;
      $('#speech-retention').textContent = saved ? 'Audio saved in this browser. Download for durable retention.' : 'Browser storage failed; download the MP3 now.';
      message('speech-message', saved ? 'Real speech generated and saved in this browser.' : 'Real speech generated. Download it now; local storage failed.', saved ? 'success' : ''); await refreshJobs(); await refreshLibrary();
    } catch (error) { message('speech-message', error.message, 'error'); }
    finally { setBusy(button, false); }
  });

  $('#transcribe-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const file = $('#audio-file').files[0]; if (!file) return message('transcribe-message', 'Choose an audio file first.', 'error');
    if (file.size > 512 * 1024) return message('transcribe-message', 'The selected file is larger than 512 KiB.', 'error');
    const ext = file.name.toLowerCase().split('.').pop(); const mimeMap = { mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac' };
    const contentType = file.type && file.type.startsWith('audio/') ? file.type : (mimeMap[ext] || 'application/octet-stream');
    const button = $('#transcribe-submit'); setBusy(button, true, 'Transcribing…'); message('transcribe-message', 'Sending a bounded upload for real speech recognition…');
    try {
      const headers = { 'Content-Type': contentType, 'X-Filename': file.name.slice(0, 120) };
      if ($('#transcribe-project').value) headers['X-Project-Id'] = $('#transcribe-project').value;
      const response = await fetch('/api/transcribe', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers, body: file });
      const data = await response.json(); if (!response.ok) throw new Error(data.message || `Transcription failed (${response.status}).`);
      $('#transcript-result').value = data.transcript; $('#copy-transcript').disabled = false; $('#save-transcript').disabled = false;
      message('transcribe-message', 'Transcript returned by Workers AI and stored as private text metadata.', 'success'); await refreshJobs(); await refreshLibrary();
    } catch (error) { message('transcribe-message', error.message, 'error'); }
    finally { setBusy(button, false); }
  });
  $('#copy-transcript').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#transcript-result').value); toast('Transcript copied.'); } catch { toast('Clipboard access was denied.', 'error'); } });
  $('#save-transcript').addEventListener('click', async () => {
    const text = $('#transcript-result').value.trim(); if (!text) return;
    try { await api('/api/assets/text', jsonOptions('POST', { title: 'Edited transcript', content: text, projectId: $('#transcribe-project').value || null, provider: 'user-edited' })); toast('Edited transcript saved.'); await refreshLibrary(); }
    catch (error) { message('transcribe-message', error.message, 'error'); }
  });

  async function renderAssemblyImages() {
    state.localAssets = await localGetAll(); const select = $('#assembly-image-list'); const chosen = new Set([...select.selectedOptions].map((o) => o.value)); select.replaceChildren();
    for (const asset of state.localAssets.filter((a) => a.type === 'image')) {
      const item = option(`${asset.title} · ${fmtBytes(asset.sizeBytes)}`, asset.id); item.selected = chosen.has(asset.id); select.append(item);
    }
    if (!select.options.length) select.append(option('Add or generate images first', ''));
  }
  $('#assembly-images').addEventListener('change', async () => {
    const files = [...$('#assembly-images').files];
    if (files.length > 10) { message('assembly-message', 'Choose up to 10 images per assembly.', 'error'); $('#assembly-images').value = ''; return; }
    for (const file of files) {
      if (!file.type.startsWith('image/') || file.size > 15 * 1024 * 1024) { message('assembly-message', `${file.name} is not a supported image or exceeds 15 MiB.`, 'error'); continue; }
      const meta = { id: newId(), type: 'image', title: file.name, mimeType: file.type, sizeBytes: file.size, createdAt: new Date().toISOString(), provider: 'Browser upload', model: 'Local source image', projectId: null };
      const saved = await saveLocalAsset(meta, file, true); if (!saved) message('assembly-message', `Could not retain ${file.name} in browser storage.`, 'error');
    }
    await renderAssemblyImages(); message('assembly-message', 'Source images are on this device only.', 'success');
  });
  $('#assembly-button').addEventListener('click', async () => {
    const selectedIds = [...$('#assembly-image-list').selectedOptions].map((o) => o.value).filter(Boolean);
    if (!selectedIds.length) return message('assembly-message', 'Select at least one local source image.', 'error');
    if (selectedIds.length > 10) return message('assembly-message', 'Select no more than 10 images.', 'error');
    if (!('MediaRecorder' in window) || !HTMLCanvasElement.prototype.captureStream) return message('assembly-message', 'This browser does not support canvas capture and MediaRecorder.', 'error');
    const duration = Number($('#assembly-duration').value); const targetSeconds = Math.min(60, duration * selectedIds.length);
    const selected = selectedIds.map((id) => state.localAssets.find((item) => item.id === id)).filter(Boolean);
    if (selected.length !== selectedIds.length || selected.some((item) => !item.blob)) return message('assembly-message', 'A selected source file is unavailable in this browser.', 'error');
    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) return message('assembly-message', 'This browser has no supported WebM MediaRecorder codec.', 'error');
    const button = $('#assemble-button'); setBusy(button, true, 'Preparing…'); $('#assembly-preview').hidden = true; $('#assembly-download').hidden = true;
    try {
      const images = await Promise.all(selected.map((asset) => loadImage(asset.blob)));
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720; const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('Canvas rendering is unavailable on this device.');
      const stream = canvas.captureStream(24); const audioFile = $('#assembly-audio').files[0]; let audioElement = null; let audioUrl = null;
      if (audioFile) {
        audioElement = new Audio(); audioUrl = URL.createObjectURL(audioFile); audioElement.src = audioUrl; audioElement.preload = 'auto';
        await new Promise((resolve, reject) => { audioElement.onloadedmetadata = resolve; audioElement.onerror = () => reject(new Error('The selected soundtrack could not be decoded by this browser.')); audioElement.load(); });
        const capture = audioElement.captureStream || audioElement.mozCaptureStream;
        if (!capture) throw new Error('This browser cannot capture a soundtrack track for local WebM assembly.');
        for (const track of capture.call(audioElement).getAudioTracks()) stream.addTrack(track);
      }
      const recorder = new MediaRecorder(stream, { mimeType }); const chunks = []; recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
      const captions = $('#assembly-captions').value.split('\n').map((x) => x.trim()); const start = performance.now();
      const draw = (now) => {
        const elapsed = now - start; const scene = Math.min(images.length - 1, Math.floor(elapsed / (duration * 1000)));
        drawCover(ctx, images[scene], canvas.width, canvas.height);
        const caption = captions[scene] || selected[scene].title || '';
        if (caption) { ctx.fillStyle = 'rgba(0,0,0,.58)'; ctx.fillRect(0, 590, canvas.width, 130); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '600 30px system-ui, sans-serif'; wrapText(ctx, caption.slice(0, 180), canvas.width - 100, 635, 40); }
        if (elapsed < targetSeconds * 1000 && !recorder.state.includes('inactive')) requestAnimationFrame(draw);
      };
      await new Promise(async (resolve, reject) => {
        recorder.onerror = () => reject(new Error('The browser MediaRecorder failed.'));
        recorder.onstop = resolve;
        recorder.start(1000); requestAnimationFrame(draw);
        if (audioElement) { try { await audioElement.play(); } catch { recorder.stop(); reject(new Error('Browser playback was blocked; tap to allow audio and retry.')); return; } }
        const timer = setInterval(() => { const elapsed = Math.min(targetSeconds, Math.floor((performance.now() - start) / 1000)); message('assembly-message', `Recording locally · ${elapsed} of ${targetSeconds} seconds`); if (elapsed >= targetSeconds && recorder.state !== 'inactive') { clearInterval(timer); recorder.stop(); if (audioElement) audioElement.pause(); } }, 500);
      });
      const blob = new Blob(chunks, { type: mimeType });
      if (!blob.size) throw new Error('The browser returned an empty video file.');
      const videoId = newId(); const videoMeta = { id: videoId, type: 'video', title: 'Browser video assembly', mimeType, sizeBytes: blob.size, createdAt: new Date().toISOString(), provider: 'Browser MediaRecorder', model: mimeType, projectId: null };
      const saved = await saveLocalAsset(videoMeta, blob, true); const url = objectUrl(blob); $('#assembly-preview').src = url; $('#assembly-preview').hidden = false; $('#assembly-download').href = url; $('#assembly-download').download = `catchi-${videoId}.webm`; $('#assembly-download').hidden = false;
      message('assembly-message', `WebM file created · ${fmtBytes(blob.size)} · ${saved ? 'retained in this browser' : 'download now; browser retention failed'}.`, saved ? 'success' : ''); toast('Video assembly completed in this browser.');
      if (audioUrl) URL.revokeObjectURL(audioUrl); stream.getTracks().forEach((track) => track.stop()); await renderAssemblyImages();
    } catch (error) { message('assembly-message', error.message, 'error'); }
    finally { setBusy(button, false); }
  });
  function loadImage(blob) {
    return new Promise((resolve, reject) => { const url = URL.createObjectURL(blob); const image = new Image(); image.onload = () => { URL.revokeObjectURL(url); resolve(image); }; image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('A source image could not be decoded.')); }; image.src = url; });
  }
  function drawCover(ctx, image, width, height) {
    const scale = Math.max(width / image.width, height / image.height); const w = image.width * scale; const h = image.height * scale; ctx.fillStyle = '#111'; ctx.fillRect(0, 0, width, height); ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
  }
  function wrapText(ctx, text, maxWidth, y, lineHeight) {
    const words = text.split(/\s+/); let line = ''; const lines = [];
    for (const word of words) { const test = line ? `${line} ${word}` : word; if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = word; } else line = test; }
    if (line) lines.push(line); const shown = lines.slice(0, 2); shown.forEach((value, index) => ctx.fillText(value, ctx.canvas.width / 2, y + index * lineHeight, maxWidth));
  }

  async function refreshLibrary() {
    try {
      const [remote, local] = await Promise.all([api('/api/assets'), localGetAll()]); state.assets = remote.items || []; state.localAssets = local;
      $('#legacy-warning').hidden = !state.assets.some((asset) => asset.legacyPublicRelease);
      renderLibrary(); await renderAssemblyImages();
    } catch (error) { $('#asset-grid').replaceChildren(empty(error.message)); }
  }
  function renderLibrary() {
    const grid = $('#asset-grid'); grid.replaceChildren();
    const projectFilter = $('#library-project').value; const typeFilter = $('#library-type').value; const search = $('#library-search').value.trim().toLowerCase();
    const localMap = new Map(state.localAssets.map((asset) => [asset.id, asset])); const all = new Map();
    for (const asset of state.assets) all.set(asset.id, { ...asset, local: localMap.get(asset.id) || null });
    for (const asset of state.localAssets) if (!all.has(asset.id)) all.set(asset.id, { ...asset, local: asset, localOnly: true });
    const items = [...all.values()].filter((asset) => (!projectFilter || asset.projectId === projectFilter) && (!typeFilter || asset.type === typeFilter) && (!search || `${asset.title} ${asset.model} ${asset.prompt}`.toLowerCase().includes(search))).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (!items.length) { grid.append(empty('No matching assets. Generate content or add a local source image.')); return; }
    for (const asset of items) grid.append(assetCard(asset));
  }
  function assetCard(asset) {
    const card = document.createElement('article'); card.className = 'asset-card';
    const local = asset.local; const fileAvailable = Boolean(local?.blob);
    if (asset.type === 'image' && fileAvailable) { const img = document.createElement('img'); img.className = 'asset-thumb'; img.alt = asset.title || 'Image asset'; img.src = objectUrl(local.blob); card.append(img); }
    else { const thumb = document.createElement('div'); thumb.className = 'asset-thumb'; thumb.textContent = asset.type === 'text' || asset.type === 'transcript' ? 'TEXT OUTPUT' : asset.type.toUpperCase(); card.append(thumb); }
    const body = document.createElement('div'); body.className = 'asset-card-body'; const title = document.createElement('h3'); title.textContent = asset.title || asset.prompt || 'Untitled'; const detail = document.createElement('p'); detail.textContent = `${asset.type} · ${asset.model || asset.provider || 'local'} · ${fmtBytes(asset.sizeBytes || local?.sizeBytes || 0)}`; const date = document.createElement('p'); date.textContent = fmtDate(asset.createdAt); body.append(title, detail, date);
    if (asset.type === 'speech' && fileAvailable) { const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none'; audio.src = objectUrl(local.blob); body.append(audio); }
    if (asset.type === 'text' || asset.type === 'transcript') { const preview = document.createElement('textarea'); preview.rows = 5; preview.readOnly = true; preview.setAttribute('aria-label', `Text content: ${asset.title}`); preview.placeholder = 'Loading saved text…'; body.append(preview); api(`/api/assets/${asset.id}`).then((data) => { preview.value = data.content || ''; }).catch((error) => { preview.value = error.message; }); }
    const actions = document.createElement('div'); actions.className = 'asset-actions';
    if (fileAvailable) { const download = document.createElement('a'); download.className = 'button secondary'; download.textContent = 'Download'; download.href = objectUrl(local.blob); download.download = `${safeFilename(asset.title || 'catchi-asset')}.${extensionFor(asset.mimeType || local.mimeType)}`; actions.append(download); }
    else if (asset.legacy && asset.fileStoredInCloud) { const download = document.createElement('a'); download.className = 'button secondary'; download.textContent = 'Retrieve legacy file'; download.href = `/asset/${asset.id}`; download.download = safeFilename(asset.filename || 'catchi-legacy-media'); actions.append(download); }
    if (!asset.legacy && !asset.localOnly) { const del = document.createElement('button'); del.className = 'button danger'; del.type = 'button'; del.textContent = 'Delete'; del.addEventListener('click', async () => { if (!confirm(`Delete “${asset.title || 'this asset'}” metadata${fileAvailable ? ' and its local browser copy' : ''}?`)) return; try { await api(`/api/assets/${asset.id}`, { method: 'DELETE' }); if (fileAvailable) await localDelete(asset.id); toast('Asset metadata deleted.'); await refreshLibrary(); } catch (error) { toast(error.message, 'error'); } }); actions.append(del); }
    if (asset.localOnly) { const del = document.createElement('button'); del.className = 'button danger'; del.type = 'button'; del.textContent = 'Remove local file'; del.addEventListener('click', async () => { if (confirm(`Remove “${asset.title}” from this browser?`)) { await localDelete(asset.id); await refreshLibrary(); } }); actions.append(del); }
    body.append(actions); card.append(body); return card;
  }
  function extensionFor(mime = '') { return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/mpeg': 'mp3', 'video/webm': 'webm', 'text/plain; charset=utf-8': 'txt' })[mime] || 'bin'; }
  function safeFilename(value) { return String(value).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100) || 'catchi-file'; }
  $('#refresh-library').addEventListener('click', refreshLibrary); $('#library-project').addEventListener('change', renderLibrary); $('#library-type').addEventListener('change', renderLibrary); $('#library-search').addEventListener('input', renderLibrary);

  async function refreshOperations() {
    try {
      const data = await api('/api/ops'); state.jobs = data.recentJobs || []; renderJobs();
      const health = await api('/api/health');
      const values = [
        ['API status', health.status], ['Build revision', data.version], ['Workers AI', data.provider.enabled ? 'Configured' : 'Unavailable'], ['Text queue', data.queue.enabled ? 'Configured' : 'Unavailable'],
        ['Image workflow', health.capabilities.imageGeneration.enabled ? 'Enabled' : 'Unavailable'], ['Speech workflow', health.capabilities.speechGeneration.enabled ? 'Enabled' : 'Unavailable'], ['Text-to-video', 'Disabled'], ['Asset retention', 'Browser-local media'],
      ];
      const cards = $('#ops-cards'); cards.replaceChildren();
      for (const [label, value] of values) { const card = document.createElement('div'); card.className = 'ops-card'; const small = document.createElement('span'); small.textContent = label; const strong = document.createElement('strong'); strong.textContent = value; card.append(small, strong); cards.append(card); }
      const budget = data.today; const details = $('#budget-detail'); details.replaceChildren();
      for (const [key, count] of Object.entries(budget.calls || {})) { const line = document.createElement('div'); line.className = 'budget-line'; const label = document.createElement('span'); label.textContent = `${key} requests`; const value = document.createElement('strong'); value.textContent = String(count); line.append(label, value); details.append(line); }
      const line = document.createElement('div'); line.className = 'budget-line'; const label = document.createElement('span'); label.textContent = 'Estimated neurons reserved'; const value = document.createElement('strong'); value.textContent = `${budget.estimatedNeuronsReserved} / ${budget.applicationEstimateCap}`; line.append(label, value); details.append(line);
      const note = document.createElement('p'); note.className = 'fine-print'; note.textContent = budget.warning; details.append(note);
    } catch (error) { $('#ops-cards').replaceChildren(empty(error.message)); }
  }
  $('#refresh-operations').addEventListener('click', refreshOperations);

  async function initialize() {
    updateConnection();
    const theme = localStorage.getItem('catchi-theme'); if (theme === 'light') document.documentElement.classList.add('light-theme');
    try {
      const session = await api('/api/auth/session');
      if (!session.authenticated) return showSignedOut();
      showWorkspace();
      await Promise.all([loadHealth(), loadProjects(), refreshJobs()]);
      await renderAssemblyImages();
      const initial = location.hash.slice(1); if (viewNames[initial]) showView(initial);
      if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    } catch (error) { showSignedOut(error.message); }
  }
  $('#signin-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = $('#signin-form button[type="submit"]'); setBusy(button, true, 'Signing in…'); message('signin-error', '');
    try { await api('/api/auth/login', jsonOptions('POST', { password: $('#signin-password').value })); $('#signin-password').value = ''; showWorkspace(); await Promise.all([loadHealth(), loadProjects(), refreshJobs()]); await renderAssemblyImages(); if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {}); }
    catch (error) { message('signin-error', error.message, 'error'); }
    finally { setBusy(button, false); }
  });
  $('#logout-button').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* locally clear the visible workspace even if offline */ }
    showSignedOut('You have signed out.');
  });
  $$('.nav-item[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
  $$('[data-open-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.openView)));
  $('#menu-toggle').addEventListener('click', () => { const open = $('#sidebar').classList.toggle('open'); $('#menu-toggle').setAttribute('aria-expanded', String(open)); });
  $('#theme-toggle').addEventListener('click', () => { const light = document.documentElement.classList.toggle('light-theme'); localStorage.setItem('catchi-theme', light ? 'light' : 'dark'); });
  $('#account-button').addEventListener('click', () => toast('Signed in as the single administrator.'));
  window.addEventListener('online', updateConnection); window.addEventListener('offline', updateConnection);
  initialize();
})();
