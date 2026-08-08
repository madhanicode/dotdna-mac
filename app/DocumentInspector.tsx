import { SnapGeneData } from "./snapgene";

type Props = {
  data: SnapGeneData;
};

const numberFormatter = new Intl.NumberFormat("en-US");

function valueOrDash(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function formatDate(date: string | null, utc: string | null) {
  if (!date) return "—";
  return utc ? `${date} · ${utc} UTC` : date;
}

export function DocumentInspector({ data }: Props) {
  const decodedPackets = data.packets.filter(({ decoded }) => decoded).length;

  return (
    <section className="document-inspector" id="file-details" aria-labelledby="document-heading">
      <div className="document-heading">
        <div>
          <span className="panel-kicker">FILE CONTENTS</span>
          <h3 id="document-heading">Inside the SnapGene document</h3>
        </div>
        <span className="packet-summary">{data.packetCount ? `${decodedPackets}/${data.packetCount} packet types interpreted` : "Interoperable text document"}</span>
      </div>

      <div className="document-grid">
        <article className="metadata-card">
          <span className="document-card-label">METADATA</span>
          <dl>
            <div><dt>Material</dt><dd>{valueOrDash(data.notes.type)}</dd></div>
            <div><dt>Created by</dt><dd>{valueOrDash(data.notes.createdBy)}</dd></div>
            <div><dt>Created</dt><dd>{formatDate(data.notes.created, data.notes.createdUtc)}</dd></div>
            <div><dt>Modified</dt><dd>{formatDate(data.notes.lastModified, data.notes.lastModifiedUtc)}</dd></div>
            <div><dt>Sequence class</dt><dd>{valueOrDash(data.notes.sequenceClass)}</dd></div>
            <div><dt>Accession</dt><dd>{valueOrDash(data.notes.accessionNumber)}</dd></div>
          </dl>
          {(data.notes.description || data.notes.comments) && (
            <div className="document-notes">
              {data.notes.description && <p>{data.notes.description}</p>}
              {data.notes.comments && <p>{data.notes.comments}</p>}
            </div>
          )}
        </article>

        <article className="metadata-card">
          <span className="document-card-label">MOLECULE &amp; PRIMERS</span>
          <dl>
            <div><dt>5′ end</dt><dd>{valueOrDash(data.sequenceProperties.upstreamModification)}</dd></div>
            <div><dt>3′ end</dt><dd>{valueOrDash(data.sequenceProperties.downstreamModification)}</dd></div>
            <div><dt>Bound primers</dt><dd>{numberFormatter.format(data.primers.length)}</dd></div>
            <div><dt>Alignable sequences</dt><dd>{numberFormatter.format(data.alignableSequenceCount)}</dd></div>
            <div><dt>Format version</dt><dd>{data.header.exportVersion === null ? "—" : `${data.header.exportVersion} / ${valueOrDash(data.header.importVersion)}`}</dd></div>
            <div><dt>UUID</dt><dd className="metadata-code">{valueOrDash(data.notes.uuid)}</dd></div>
          </dl>
          {data.primers.length > 0 && (
            <ol className="primer-list">
              {data.primers.map((primer, index) => (
                <li key={`${primer.name}-${index}`}>
                  <strong>{primer.name}</strong>
                  <span>{primer.sequence || "Sequence not stored"}</span>
                  <small>{primer.bindingSites.length} binding site{primer.bindingSites.length === 1 ? "" : "s"}</small>
                </li>
              ))}
            </ol>
          )}
        </article>
      </div>

      {data.packetCount > 0 && <details className="packet-manifest">
        <summary><span>Packet manifest</span><small>See every section found in this file</small></summary>
        <div className="packet-table-wrap">
          <table className="packet-table">
            <thead><tr><th>#</th><th>Packet</th><th>Type</th><th>Format</th><th>Size</th><th>Status</th></tr></thead>
            <tbody>
              {data.packets.map((packet) => (
                <tr key={`${packet.index}-${packet.type}`}>
                  <td>{packet.index + 1}</td>
                  <td><strong>{packet.name}</strong></td>
                  <td className="metadata-code">{packet.hexType}</td>
                  <td>{packet.format}</td>
                  <td>{numberFormatter.format(packet.byteLength)} B</td>
                  <td><span className={packet.decoded ? "packet-status decoded" : "packet-status preserved"}>{packet.decoded ? "Decoded" : "Indexed"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="packet-note">Structured sequence, feature, primer, note, end-chemistry, enzyme-set, alignment, and visibility packets are decoded. Proprietary binary display/history packets are safely indexed and skipped.</p>
      </details>}
    </section>
  );
}
