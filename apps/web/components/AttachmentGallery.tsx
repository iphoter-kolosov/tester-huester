import type { Attachment } from '@th/db'
import ShotWithEditor from './ShotWithEditor'

// The "ten tickets in one" section: every attached image is shown at its own number, with the reporter's
// caption under it, the full-resolution file one click away, and the same annotator the main screenshot has —
// so a reviewer can mark up attachment #7 and drop the result into the thread without leaving the page.
//
// Composition only: the drawing engine and the annotate launcher are ShotWithEditor / ShotEditor, unchanged.
export default function AttachmentGallery({ items, reportId }: { items: Attachment[]; reportId: string }) {
  if (!items.length) return null
  return (
    <section className="atts">
      <div className="attshead">
        <span className="attsttl">Вложения</span>
        <span className="attsn">{items.length}</span>
      </div>
      {items.map((a, i) => (
        <figure className="att" key={a.id}>
          <div className="atttop">
            <span className="attnum">{i + 1}</span>
            <a className="attopen" href={a.url} target="_blank" rel="noreferrer">полный размер ↗</a>
          </div>
          <ShotWithEditor src={a.url} reportId={reportId} linkFullSize />
          <figcaption className={'attcap' + (a.caption ? '' : ' attcap-empty')}>{a.caption || 'без описания'}</figcaption>
        </figure>
      ))}
    </section>
  )
}
