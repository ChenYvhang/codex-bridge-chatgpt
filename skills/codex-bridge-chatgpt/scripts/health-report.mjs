function secondsSince(iso, now) {
  if (!iso) return null;
  const value = Math.floor((new Date(now).getTime() - new Date(iso).getTime()) / 1000);
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

function checkSummary(check) {
  if (typeof check === 'string') return { name: check, status: 'reported' };
  return {
    name: check?.name ?? check?.id ?? check?.command ?? 'unnamed check',
    status: check?.status ?? check?.result ?? 'reported',
  };
}

function artifactSummary(artifact) {
  if (typeof artifact === 'string') return { path: artifact, status: 'reported' };
  return { path: artifact?.path ?? artifact?.artifact_id ?? 'unnamed artifact', status: artifact?.status ?? 'reported' };
}

export function buildHealthReport({ state, checkpoint = null, checkpointIntegrity = null, receipt = null, receiptIntegrity = null, cost = null, now = new Date().toISOString() }) {
  const capabilities = state.chat?.capabilities ?? {};
  const available = Object.keys(capabilities).filter((name) => capabilities[name] === true).sort();
  const missing = Object.keys(capabilities).filter((name) => capabilities[name] !== true).sort();
  const warnings = [];
  if (state.chat?.protocol?.status !== 'ready') warnings.push({ code: 'PROTOCOL_BOOTSTRAP_REQUIRED', action: 'bootstrap_chat_protocol' });
  if (checkpointIntegrity === false) warnings.push({ code: 'CHECKPOINT_INTEGRITY_FAILED', action: 'refresh_checkpoint' });
  if (receiptIntegrity === false) warnings.push({ code: 'RECEIPT_INTEGRITY_FAILED', action: 'inspect_last_round' });
  if (!checkpoint && state.last_completed_round > 0) warnings.push({ code: 'CHECKPOINT_MISSING', action: 'create_checkpoint' });
  else if (checkpoint && checkpoint.through_round < state.last_completed_round) warnings.push({ code: 'CHECKPOINT_BEHIND', action: 'refresh_checkpoint' });
  if ((state.pending_questions ?? []).length > 0) warnings.push({ code: 'QUESTIONS_PENDING', action: 'batch_questions' });
  if ((state.pending_artifacts ?? []).length > 0) warnings.push({ code: 'ARTIFACTS_PENDING', action: 'inspect_last_round' });
  if ((cost?.totals?.wasted_response_tokens ?? 0) > 0) warnings.push({ code: 'INVALID_RESPONSE_COST', action: 'inspect_cost' });

  return {
    status: state.status,
    chat: {
      title: state.chat?.title ?? null,
      transport: state.chat?.transport ?? null,
      identity_status: state.chat?.identity_status ?? null,
    },
    protocol: state.chat?.protocol ? { version: state.chat.protocol.version, status: state.chat.protocol.status } : null,
    round: {
      current: state.in_flight?.round ?? null,
      phase: state.in_flight?.phase ?? null,
      last_completed: state.last_completed_round,
      last_outcome: state.last_exchange?.outcome ?? null,
      last_completed_age_seconds: secondsSince(state.last_exchange?.completed_at, now),
    },
    transport: { available_capabilities: available, missing_capabilities: missing },
    context: {
      checkpoint_present: Boolean(checkpoint),
      through_round: checkpoint?.through_round ?? null,
      checkpoint_age_seconds: secondsSince(state.checkpoint?.updated_at, now),
      checkpoint_integrity: checkpointIntegrity,
      durable_entries: checkpoint?.entries?.length ?? 0,
      pending_questions: state.pending_questions?.length ?? 0,
      pending_artifacts: state.pending_artifacts?.length ?? 0,
    },
    latest_receipt: receipt ? {
      integrity: receiptIntegrity,
      implementation_summary: receipt.implementation_summary ?? null,
      artifacts: (receipt.artifacts ?? receipt.changed_files ?? []).map(artifactSummary),
      checks: (receipt.checks ?? []).map(checkSummary),
      accepted: receipt.accepted?.length ?? 0,
      rejected: receipt.rejected?.length ?? 0,
      deferred: receipt.deferred?.length ?? 0,
    } : null,
    cost: cost?.totals ?? null,
    warnings,
    healthy: warnings.filter((warning) => ['CHECKPOINT_INTEGRITY_FAILED', 'RECEIPT_INTEGRITY_FAILED', 'PROTOCOL_BOOTSTRAP_REQUIRED'].includes(warning.code)).length === 0,
  };
}
