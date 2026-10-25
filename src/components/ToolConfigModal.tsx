import React from 'react';
import { useStore } from '../store/useStore';
import { useShallow } from 'zustand/react/shallow';
import { ToolRackModal } from '@physbox-io/ui';
import { DEFAULT_TOOL_RACK, RACK_PRESETS, cuttingDefaults, type RackTool } from '@physbox-io/machining';
import { DEFAULT_TOOL, TOOL_OPERATIONS, profileFromRackTool, toolRackStore } from '../utils/tooling';

const USES = TOOL_OPERATIONS.map((op) => ({ id: op, label: op.charAt(0).toUpperCase() + op.slice(1) }));

/**
 * The tool library, as the dialog every app shares.
 *
 * It edits the shared rack's own entries, so a field Etch has no use for —
 * a drill's shape, an RPM set in Volt — is not flattened by an edit made here.
 * The edit still goes through `setCncTools`, which is what the planners, the
 * document's carried tools and the storage warning all hang off.
 */
export const ToolConfigModal: React.FC = () => {
  const { isOpen, close, cncTools, setCncTools, resetCncTools, unsaved, layers } = useStore(
    useShallow((s) => ({
      isOpen: s.isToolConfigModalOpen,
      close: s.closeToolConfigModal,
      // Read for the re-render only: the rack below has just been written
      // whenever this changes.
      cncTools: s.cncTools,
      setCncTools: s.setCncTools,
      resetCncTools: s.resetCncTools,
      unsaved: s.cncToolsUnsaved,
      layers: s.document.layers,
    })),
  );

  // The rack's own entries, with what Etch would derive for a description the
  // entry does not carry, so the dialog shows the guidance the inspector shows.
  const tools: RackTool[] = React.useMemo(() => {
    void cncTools;
    return toolRackStore.get().tools.map((t) => {
      const profile = profileFromRackTool(t);
      return {
        ...t,
        bestFor: t.bestFor ?? profile.bestFor,
        guidance: t.guidance ?? profile.guidance,
        minDetailMm: t.minDetailMm ?? profile.minDetailMm,
      };
    });
  }, [cncTools]);

  return (
    <ToolRackModal
      open={isOpen}
      onClose={close}
      tools={tools}
      onChange={(next) => setCncTools(next.map(profileFromRackTool).sort((a, b) => a.id - b.id), next)}
      onReset={resetCncTools}
      defaultCount={DEFAULT_TOOL_RACK.length}
      presets={RACK_PRESETS}
      uses={USES}
      cuttingDefaults={cuttingDefaults}
      usedBy={(n) => layers.filter((l) => (l.tool ?? DEFAULT_TOOL) === n).map((l) => l.name)}
      unsaved={unsaved}
      note="This rack is shared with Volt and Mesh through your account: an edit here is the rack they offer too."
    />
  );
};
