import { Endpoint, ServiceNode } from '../types/flow';

function isMissing(value?: string | null) {
  return !value || value === '-' || value === '<unknown>';
}

export function cleanLabel(value?: string | null): string {
  return isMissing(value) ? '' : value!;
}

function friendlyExternalName(value?: string | null) {
  switch (cleanLabel(value).toLowerCase()) {
    case 'pvt':
      return 'Private network';
    case 'pub':
      return 'Public network';
    default:
      return '';
  }
}

export function formatEndpointTitle(endpoint: Endpoint) {
  const serviceName = cleanLabel(endpoint.serviceName);
  if (serviceName) {
    return serviceName;
  }

  const externalName = friendlyExternalName(endpoint.name);
  if (externalName) {
    return externalName;
  }

  const name = cleanLabel(endpoint.name);
  if (name) {
    return name;
  }

  switch (endpoint.kind) {
    case 'external':
    case 'net':
      return 'External endpoint';
    case 'hep':
      return 'Host endpoint';
    case 'ns':
      return 'Network set';
    default:
      return 'Unnamed endpoint';
  }
}

export function formatEndpointSubtitle(endpoint: Endpoint) {
  const serviceNamespace = cleanLabel(endpoint.serviceNamespace);
  if (serviceNamespace) {
    return serviceNamespace;
  }

  const namespace = cleanLabel(endpoint.namespace);
  if (namespace) {
    return namespace;
  }

  if (friendlyExternalName(endpoint.name)) {
    return 'external network';
  }

  switch (endpoint.kind) {
    case 'external':
    case 'net':
      return 'external network';
    case 'hep':
      return 'host endpoint';
    case 'ns':
      return 'network set';
    default:
      return 'default';
  }
}

export function formatNodeTitle(node: ServiceNode) {
  const displayName = cleanLabel(node.displayName);
  if (displayName) {
    return displayName;
  }

  const externalName = friendlyExternalName(node.name);
  if (externalName) {
    return externalName;
  }

  const name = cleanLabel(node.name);
  if (name) {
    return name;
  }

  switch (node.kind) {
    case 'namespace':
      return 'Unnamed namespace';
    case 'external':
    case 'net':
      return 'External endpoint';
    case 'hep':
      return 'Host endpoint';
    case 'ns':
      return 'Network set';
    default:
      return 'Unnamed endpoint';
  }
}

export function formatNodeSubtitle(node: ServiceNode) {
  const subtitle = cleanLabel(node.subtitle);
  if (subtitle) {
    return subtitle;
  }

  const namespace = cleanLabel(node.namespace);
  if (namespace) {
    return namespace;
  }

  if (friendlyExternalName(node.name)) {
    return 'external network';
  }

  switch (node.kind) {
    case 'external':
    case 'net':
      return 'external network';
    case 'hep':
      return 'host endpoint';
    case 'ns':
      return 'network set';
    case 'namespace':
      return 'namespace overview';
    default:
      return 'default';
  }
}
