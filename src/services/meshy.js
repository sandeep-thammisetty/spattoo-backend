import { config } from '../config.js';

const BASE = 'https://api.meshy.ai/openapi/v1/image-to-3d';

function apiKey() {
  if (!config.meshy.apiKey) {
    throw new Error('MESHY_API_KEY is not set — add it to .env (local) / Render env (prod)');
  }
  return config.meshy.apiKey;
}

// Create an image-to-3D task. `imageUrl` must be a public URL or a base64 data URI.
// Single-stage: returns the task id immediately; generation runs for minutes inside Meshy.
// Caller tracks completion via the webhook (prod) or by polling getTask (local/fallback).
export async function createImageTo3DTask({
  imageUrl,
  shouldTexture = true,
  aiModel = 'latest',
  targetPolycount,
  targetFormats = ['glb'],
}) {
  const body = {
    image_url: imageUrl,
    should_texture: shouldTexture,
    ai_model: aiModel,
    target_formats: targetFormats,
  };
  if (targetPolycount) body.target_polycount = targetPolycount;

  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Meshy create failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  // Meshy returns { result: "<task_id>" }
  return data.result;
}

// Fetch a task's current state: { id, status, progress, model_urls, thumbnail_url,
// consumed_credits, task_error }. status ∈ PENDING|IN_PROGRESS|SUCCEEDED|FAILED|CANCELED.
export async function getTask(taskId) {
  const res = await fetch(`${BASE}/${taskId}`, {
    headers: { 'Authorization': `Bearer ${apiKey()}` },
  });
  if (!res.ok) throw new Error(`Meshy get failed (${res.status}): ${await res.text()}`);
  return res.json();
}
