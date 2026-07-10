// Shared astryx chips for item type, status, and spec presence.
import { Badge } from '@astryxdesign/core/Badge';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';

const TYPE_VARIANT = { frontend: 'blue', backend: 'purple', integration: 'teal' };
// planned is red app-wide (diagram borders, board columns) — keep that language.
const STATUS_VARIANT = { planned: 'error', 'in-progress': 'warning', shipped: 'success' };

export function TypeBadge({ type }) {
  return <Badge variant={TYPE_VARIANT[type] || 'neutral'} label={type} />;
}

export function StatusChip({ status }) {
  return (
    <>
      <StatusDot variant={STATUS_VARIANT[status] || 'neutral'} label={status} />
      <Text type="supporting" size="xsm">{status}</Text>
    </>
  );
}

export function SpecFlag({ spec }) {
  return spec
    ? <Text type="supporting" size="xsm" color="accent"><span title={spec}>spec ✓</span></Text>
    : <Text type="supporting" size="xsm"><em>no spec</em></Text>;
}

export { STATUS_VARIANT };
