import type { ReactNode } from "react";

/** 首页分区标题：编号、标题、说明的统一排版。 */
export function SectionHeading({ id, title, lead, eyebrow }: { id: string; title: ReactNode; lead?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="ch-section-heading">
      {eyebrow ? <p className="ch-eyebrow">{eyebrow}</p> : null}
      <h2 id={id}>{title}</h2>
      {lead ? <p className="ch-section-lead">{lead}</p> : null}
    </div>
  );
}
