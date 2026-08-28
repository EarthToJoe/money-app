import type { CategoryId } from '../types';
import { categoryDef } from '../data/categories';

/** Small colored identity chip for a category. Used everywhere a category is shown. */
export function CategoryChip({ id }: { id: CategoryId }) {
  const def = categoryDef(id);
  return (
    <span className="chip">
      <span className="dot" style={{ background: def.color }} />
      {def.label}
    </span>
  );
}
