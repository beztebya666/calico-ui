import { ActionType, Flow, PolicyHitInfo, ReporterType } from '../types/flow';
import { cleanLabel } from './labels';

export function formatReporterLabel(reporter?: ReporterType | string) {
  switch (reporter) {
    case 'src':
      return 'Source';
    case 'dst':
      return 'Destination';
    default:
      return 'Unknown';
  }
}

export function formatReporterHint(reporter?: ReporterType | string) {
  switch (reporter) {
    case 'src':
      return 'Observed from the source side of the flow.';
    case 'dst':
      return 'Observed from the destination side of the flow.';
    default:
      return 'Reporter not provided by Goldmane.';
  }
}

export function formatPolicyHit(hit?: PolicyHitInfo | null) {
  if (!hit) {
    return 'Policy trace not reported';
  }

  const kind = cleanLabel(hit.kind) || 'Policy';
  const namespace = cleanLabel(hit.namespace);
  const name = cleanLabel(hit.name);
  const tier = cleanLabel(hit.tier);

  if (name && namespace) {
    return `${kind} ${namespace}/${name}`;
  }
  if (name) {
    return `${kind} ${name}`;
  }
  if (tier) {
    return `${kind} in tier ${tier}`;
  }
  return kind;
}

export function formatPolicySummary(flow: Flow) {
  const enforced = flow.policies.enforced;
  const pending = flow.policies.pending;

  if (enforced.length > 0) {
    const summary = formatPolicyHit(enforced[0]);
    return enforced.length > 1 ? `${summary} +${enforced.length - 1}` : summary;
  }

  if (pending.length > 0) {
    const summary = formatPolicyHit(pending[0]);
    return pending.length > 1 ? `Pending ${summary} +${pending.length - 1}` : `Pending ${summary}`;
  }

  return flow.action === 'Deny' ? 'No named policy trace' : 'Policy trace not reported';
}

export function formatPolicyTraceDetail(flow: Flow) {
  const groups: string[] = [];

  if (flow.policies.enforced.length > 0) {
    groups.push(`Enforced: ${flow.policies.enforced.map(formatPolicyHit).join('; ')}`);
  }
  if (flow.policies.pending.length > 0) {
    groups.push(`Pending: ${flow.policies.pending.map(formatPolicyHit).join('; ')}`);
  }

  if (groups.length === 0) {
    return flow.action === 'Deny'
      ? 'Goldmane reported a deny action but did not attach a named policy hit.'
      : 'Goldmane did not attach policy hits to this flow.';
  }

  return groups.join(' | ');
}

export function formatActionExplanation(action: ActionType, reporter?: ReporterType | string) {
  const reporterLabel = formatReporterLabel(reporter).toLowerCase();
  switch (action) {
    case 'Allow':
      return `This ${reporterLabel} view observed the flow as allowed.`;
    case 'Deny':
      return `This ${reporterLabel} view observed the flow as denied.`;
    case 'Pass':
      return `This ${reporterLabel} view observed the flow as passed without a final allow or deny decision at this point.`;
    default:
      return 'Flow action explanation unavailable.';
  }
}

