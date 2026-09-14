import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeChatReference(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('chat reference must be non-empty');
  let url;
  try {
    url = new URL(raw);
  } catch {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) throw new Error('chat reference URL is invalid');
    return raw;
  }
  const host = url.hostname.toLowerCase();
  const chatMatch = url.pathname.match(/^\/c\/([^/?#]+)\/?$/);
  if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com')) {
    if (url.protocol !== 'https:' || !chatMatch) throw new Error('ChatGPT chat reference must be a secure conversation URL');
    let chatId;
    try { chatId = decodeURIComponent(chatMatch[1]); }
    catch { throw new Error('ChatGPT chat reference contains an invalid identifier'); }
    if (!/^[A-Za-z0-9_-]+$/.test(chatId)) throw new Error('ChatGPT chat reference contains an invalid identifier');
    return `chatgpt:c:${chatId}`;
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function chatReferenceSha256(chatRef) {
  return sha256(normalizeChatReference(chatRef));
}

export function workspaceScopeFingerprint(workspace) {
  const hasCanonicalIdentity = typeof workspace?.canonical_root === 'string' && workspace.canonical_root;
  if (!hasCanonicalIdentity) return workspace?.fingerprint_id ?? null;
  return sha256(JSON.stringify({
    canonical_root: workspace.canonical_root,
    repository_root: workspace.repository_root ?? null,
    remote: workspace.remote ?? null,
    worktree: workspace.worktree ?? null,
  }));
}

export function createConversationScope({ bridgeId, chatRef, workspaceFingerprintId, scopeKey = null, boundAt = null }) {
  if (!bridgeId?.trim()) throw new Error('bridge id must be non-empty');
  if (!workspaceFingerprintId?.trim()) throw new Error('workspace fingerprint must be non-empty');
  const normalizedRef = normalizeChatReference(chatRef);
  const key = scopeKey ?? randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('scope key must be a 32-byte lowercase hex value');
  const payload = `${bridgeId}\0${workspaceFingerprintId}\0${normalizedRef}`;
  return {
    schema_version: 1,
    id: createHmac('sha256', key).update(payload).digest('hex'),
    key,
    chat_ref_sha256: sha256(normalizedRef),
    workspace_fingerprint_id: workspaceFingerprintId,
    bound_at: boundAt ?? new Date().toISOString(),
  };
}

export function validateConversationScope(state) {
  const scope = state?.conversation_scope;
  if (scope?.schema_version !== 1) return ['conversation_scope.schema_version must be 1'];
  if (!/^[a-f0-9]{64}$/.test(scope?.id ?? '')) return ['conversation_scope.id is invalid'];
  if (!/^[a-f0-9]{64}$/.test(scope?.key ?? '')) return ['conversation_scope.key is invalid'];
  if (!/^[a-f0-9]{64}$/.test(scope?.chat_ref_sha256 ?? '')) return ['conversation_scope.chat_ref_sha256 is invalid'];
  if (typeof scope?.workspace_fingerprint_id !== 'string' || !scope.workspace_fingerprint_id) return ['conversation_scope.workspace_fingerprint_id is invalid'];
  if (typeof scope?.bound_at !== 'string' || !scope.bound_at) return ['conversation_scope.bound_at is invalid'];

  let expected;
  try {
    expected = createConversationScope({
      bridgeId: state.bridge_id,
      chatRef: state.chat?.ref,
      workspaceFingerprintId: workspaceScopeFingerprint(state.workspace),
      scopeKey: scope.key,
      boundAt: scope.bound_at,
    });
  } catch (error) {
    return [`conversation_scope cannot be derived: ${error.message}`];
  }
  const errors = [];
  const equalHex = (left, right) => {
    const a = Buffer.from(left, 'hex');
    const b = Buffer.from(right, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  };
  if (!equalHex(scope.id, expected.id)) errors.push('conversation_scope.id does not match the bound Chat and workspace');
  if (!equalHex(scope.chat_ref_sha256, expected.chat_ref_sha256)) errors.push('conversation_scope.chat_ref_sha256 does not match the bound Chat');
  if (scope.workspace_fingerprint_id !== workspaceScopeFingerprint(state.workspace)) errors.push('conversation_scope.workspace_fingerprint_id does not match the workspace');
  return errors;
}

export function publicConversationScope(scope) {
  return scope ? {
    schema_version: scope.schema_version,
    id: scope.id,
    chat_ref_sha256: scope.chat_ref_sha256,
    workspace_fingerprint_id: scope.workspace_fingerprint_id,
    bound_at: scope.bound_at,
  } : null;
}
