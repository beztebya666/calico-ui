import { ALL_NAMESPACES } from '../stores/flowStore';

export function formatNamespaceLabel(namespace: string): string {
  if (!namespace) {
    return 'Select...';
  }

  if (namespace === ALL_NAMESPACES || namespace === '__all__') {
    return 'All Namespaces';
  }

  if (namespace === '-') {
    return 'default';
  }

  return namespace;
}
