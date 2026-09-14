import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Folder, MoreHorizontal, Plus } from 'lucide-react';
import type { Folder as FolderItem } from '../api';

export type FolderFilter = 'all' | 'unfiled' | string;

export function FolderBar({
  folders,
  filter,
  onFilter,
  onCreate,
  onRename,
  onDelete,
}: {
  folders: FolderItem[];
  filter: FolderFilter;
  onFilter: (next: FolderFilter) => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (folder: FolderItem) => void;
}) {
  const createInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [menuId, setMenuId] = useState<string | null>(null);
  const selected = folders.find((folder) => folder.id === filter);

  useEffect(() => {
    if (!menuId && !creating && !renaming) return;
    const onPointer = (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest('[data-folder-bar]')) return;
      setMenuId(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuId(null);
        setCreating(false);
        setCreateName('');
        setRenaming(null);
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuId, creating, renaming]);

  const submitCreate = () => {
    const name = createName.trim();
    if (!name) {
      createInput.current?.focus();
      return;
    }
    void onCreate(name)
      .then(() => {
        setCreateName('');
        setCreating(false);
      })
      .catch(() => {
        createInput.current?.focus();
      });
  };

  const submitRename = (id: string) => {
    const name = renameValue.trim();
    if (!name) {
      setRenaming(null);
      return;
    }
    void onRename(id, name)
      .then(() => setRenaming(null))
      .catch(() => undefined);
  };

  const pick = (next: FolderFilter) => {
    onFilter(filter === next ? 'all' : next);
  };

  return (
    <div className="folder-bar" data-folder-bar>
      <button
        type="button"
        className="folder-bar-toggle"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
          setMenuId(null);
          setCreating(false);
          setRenaming(null);
        }}
      >
        <span>資料夾</span>
        {!open && selected && <span className="folder-bar-current">{selected.name}</span>}
        <ChevronDown size={14} className={open ? 'open' : undefined} />
      </button>
      {open && (
        <div className="folder-bar-chips">
          {creating ? (
            <form
              className="folder-chip create"
              onSubmit={(event) => {
                event.preventDefault();
                submitCreate();
              }}
            >
              <Plus size={16} />
              <input
                ref={createInput}
                autoFocus
                aria-label="新資料夾名稱"
                placeholder="資料夾名稱"
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                onBlur={() => {
                  if (!createName.trim()) setCreating(false);
                }}
              />
            </form>
          ) : (
            <button type="button" className="folder-chip create" onClick={() => setCreating(true)}>
              <Plus size={16} />
              建立資料夾
            </button>
          )}
          {folders.map((folder) => (
            <div key={folder.id} className={`folder-chip ${filter === folder.id ? 'active' : ''}`}>
              <Folder size={16} />
              {renaming === folder.id ? (
                <input
                  autoFocus
                  aria-label="重新命名資料夾"
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onBlur={() => submitRename(folder.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') submitRename(folder.id);
                    if (event.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <button type="button" className="folder-chip-name" onClick={() => pick(folder.id)}>
                  {folder.name}
                </button>
              )}
              <div className="folder-chip-more">
                <button
                  type="button"
                  className="icon"
                  aria-label={`${folder.name} 的更多動作`}
                  aria-expanded={menuId === folder.id}
                  aria-haspopup="menu"
                  onClick={() => setMenuId((current) => (current === folder.id ? null : folder.id))}
                >
                  <MoreHorizontal size={16} />
                </button>
                {menuId === folder.id && (
                  <div className="flow-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuId(null);
                        setRenaming(folder.id);
                        setRenameValue(folder.name);
                      }}
                    >
                      編輯
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="danger"
                      onClick={() => {
                        setMenuId(null);
                        onDelete(folder);
                      }}
                    >
                      刪除
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
