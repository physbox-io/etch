import React from 'react';
import { ChevronRight, Boxes, Ungroup, Group as GroupIcon, Eye, EyeOff, Link2, Unlink2 } from 'lucide-react';
import { useStore } from '../store/useStore';
import type { EtchElement } from '../types/etch';

/**
 * The objects strip: which elements on this sheet make up one thing.
 *
 * It sits between the inspector and the operation layers because that is the
 * order of the questions — what is this shape, what is it part of, what does
 * the machine do to it — and it starts closed because most documents have no
 * objects in them and an empty section that is always open is just a heading
 * pushing the layers down the panel.
 *
 * Open/closed is component state rather than document state on purpose. Which
 * rows the operator has folded away is a view of the drawing, not part of it:
 * saved in the file it would travel to whoever opened it next, and it would
 * push an undo entry every time a chevron was clicked.
 */
export const ObjectsPanel: React.FC = () => {
  const document = useStore((s) => s.document);
  const selectedIds = useStore((s) => s.selectedIds);
  const setSelectedIds = useStore((s) => s.setSelectedIds);
  const selectObject = useStore((s) => s.selectObject);
  const groupSelected = useStore((s) => s.groupSelected);
  const ungroupSelected = useStore((s) => s.ungroupSelected);
  const renameObject = useStore((s) => s.renameObject);
  const setObjectVisible = useStore((s) => s.setObjectVisible);
  const updateElement = useStore((s) => s.updateElement);
  const commitHistory = useStore((s) => s.commitHistory);
  const joinSelected = useStore((s) => s.joinSelected);
  const unjoinSelected = useStore((s) => s.unjoinSelected);
  const joinNotice = useStore((s) => s.joinNotice);

  const [open, setOpen] = React.useState(false);
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});

  const objects = document.objects ?? [];

  // One pass over the elements rather than a filter per object: this renders on
  // every selection change, and a sheet of ninety elements in eight objects is
  // an ordinary drawing here.
  const membersByObject = React.useMemo(() => {
    const map = new Map<string, EtchElement[]>();
    for (const el of document.elements) {
      if (!el.objectId) continue;
      const list = map.get(el.objectId);
      if (list) list.push(el);
      else map.set(el.objectId, [el]);
    }
    return map;
  }, [document.elements]);

  const selected = new Set(selectedIds);
  const canGroup = selectedIds.length > 1;
  // The button turns into Unjoin when what is selected is already joined, so
  // the way back is where the way in was.
  const joinedSelected = document.elements.some(
    (el) => selected.has(el.id) && (el.joinPieces || el.joinedFrom?.length)
  );

  return (
    <div className="shrink-0 border-t border-slate-200 dark:border-slate-800/80">
      <div className="flex items-center justify-between px-4 py-2.5">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider cursor-pointer"
        >
          <ChevronRight
            className={`w-3.5 h-3.5 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}
          />
          <Boxes className="w-3.5 h-3.5 text-violet-500" />
          <span>Objects</span>
          {objects.length > 0 && (
            <span className="text-[10px] font-semibold text-slate-400 normal-case tracking-normal">
              {objects.length}
            </span>
          )}
        </button>
        <div className="flex items-center">
          <button
            onClick={groupSelected}
            disabled={!canGroup}
            title={
              canGroup
                ? 'Put the selected elements in one object'
                : 'Select two or more elements to group them'
            }
            className="p-1 rounded text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 enabled:hover:bg-slate-200 dark:enabled:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            <GroupIcon className="w-3.5 h-3.5" />
          </button>
          {/*
            Join sits beside Group because they answer the same question about a
            selection — is this one thing? — at two depths. Group says so to the
            editor; Join makes it so in the material, with bridges, so a word
            whose letters do not touch comes off the machine as one pendant
            rather than a handful of letters. Offered from one element up: a
            single line of text is usually several pieces already.
          */}
          <button
            onClick={joinedSelected ? unjoinSelected : joinSelected}
            disabled={selectedIds.length === 0}
            title={
              joinedSelected
                ? 'Unjoin: take the bridges out. Joined text stays text; joined shapes come back as the pieces they were made from'
                : selectedIds.length
                  ? 'Join into one piece: bridge the gaps between letters or shapes that do not touch, so the whole thing cuts out as one part. Text stays editable'
                  : 'Select text or shapes to join them into one piece'
            }
            className={`ml-1 p-1 rounded disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors ${
              joinedSelected
                ? 'text-violet-700 dark:text-violet-300 bg-violet-100 dark:bg-violet-500/20 enabled:hover:bg-violet-200 dark:enabled:hover:bg-violet-500/30'
                : 'text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 enabled:hover:bg-slate-200 dark:enabled:hover:bg-slate-700'
            }`}
          >
            {joinedSelected ? <Unlink2 className="w-3.5 h-3.5" /> : <Link2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Outside the fold: the panel starts closed, and a join done from a
          closed panel still has to say what it did. */}
      {joinNotice && (
        <p className="px-4 pb-2 -mt-1 text-[10px] text-slate-600 dark:text-slate-400 leading-relaxed">
          {joinNotice}
        </p>
      )}

      {open && (
        <div className="max-h-52 overflow-y-auto px-4 pb-3 space-y-1">
          {objects.length === 0 && (
            <p className="text-[11px] text-slate-400 dark:text-slate-500 leading-relaxed">
              Nothing is grouped yet. Duplicating several elements at once puts the copies in an
              object; so does the button above.
            </p>
          )}

          {objects.map((object) => {
            const members = membersByObject.get(object.id) ?? [];
            const isOpen = expanded[object.id] ?? false;
            // "Selected" means the whole object is, not merely that one of its
            // elements is — otherwise every row lights up while a single shape
            // inside one of them is being edited.
            const whole = members.length > 0 && members.every((el) => selected.has(el.id));
            // Shown as hidden only when the whole object is. A part of one
            // that has been hidden on its own leaves the eye open, so the row
            // does not claim the rest of it is gone too.
            const anyVisible = members.some((el) => el.visible !== false);

            return (
              <div
                key={object.id}
                className={`rounded border ${
                  whole
                    ? 'border-violet-400 dark:border-violet-500/70 bg-violet-50 dark:bg-violet-500/10'
                    : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/40'
                }`}
              >
                <div className="flex items-center gap-1 px-1.5 py-1">
                  <button
                    onClick={() => setExpanded((e) => ({ ...e, [object.id]: !isOpen }))}
                    title={isOpen ? 'Hide contents' : 'Show contents'}
                    className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer"
                  >
                    <ChevronRight
                      className={`w-3 h-3 text-slate-400 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                    />
                  </button>

                  {/* The row selects; the name is edited in place. A flat input
                      rather than a double-click-to-edit dance, which is a
                      gesture nobody discovers. */}
                  <input
                    value={object.name}
                    onChange={(e) => renameObject(object.id, e.target.value)}
                    onBlur={commitHistory}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                    className="flex-1 min-w-0 bg-transparent text-xs font-semibold text-slate-700 dark:text-slate-200 px-1 py-0.5 rounded outline-none focus:bg-white dark:focus:bg-slate-800"
                  />

                  <button
                    onClick={() => setObjectVisible(object.id, !anyVisible)}
                    disabled={members.length === 0}
                    title={
                      anyVisible
                        ? 'Hide this object — hidden elements are not drawn and are not machined'
                        : 'Show this object'
                    }
                    className="p-0.5 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {anyVisible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                  </button>
                  <button
                    onClick={() => selectObject(object.id)}
                    title="Select everything in this object"
                    className="text-[10px] font-semibold text-slate-400 hover:text-violet-500 px-1 cursor-pointer"
                  >
                    {members.length}
                  </button>
                  <button
                    onClick={() => ungroupSelected(object.id)}
                    title="Ungroup — the elements stay where they are"
                    className="p-0.5 rounded text-slate-400 hover:text-rose-500 hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer"
                  >
                    <Ungroup className="w-3 h-3" />
                  </button>
                </div>

                {isOpen && (
                  <ul className="pb-1 pl-6 pr-1.5 space-y-0.5">
                    {members.map((el) => (
                      <li key={el.id} className="flex items-center gap-1">
                        <button
                          onClick={() => setSelectedIds([el.id])}
                          className={`flex-1 min-w-0 text-left text-[11px] truncate px-1.5 py-0.5 rounded cursor-pointer ${
                            selected.has(el.id)
                              ? 'bg-violet-500/20 text-violet-700 dark:text-violet-200'
                              : 'text-slate-500 dark:text-slate-400 hover:bg-slate-200/70 dark:hover:bg-slate-800'
                          } ${el.visible === false ? 'line-through opacity-50' : ''}`}
                        >
                          {el.name || el.type}
                        </button>
                        <button
                          onClick={() => updateElement(el.id, { visible: el.visible === false })}
                          title={el.visible === false ? 'Show' : 'Hide'}
                          className="shrink-0 p-0.5 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer"
                        >
                          {el.visible === false
                            ? <EyeOff className="w-3 h-3" />
                            : <Eye className="w-3 h-3" />}
                        </button>
                      </li>
                    ))}
                    {members.length === 0 && (
                      <li className="text-[11px] text-slate-400 px-1.5 py-0.5">Empty</li>
                    )}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
