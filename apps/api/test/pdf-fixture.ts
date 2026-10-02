// Minimal, deterministic PDF fixture with correct cross-reference offsets.
export function makePdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const kids = pages.map((_text, index) => 4 + index * 2 + ' 0 R').join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(
    '<< /Type /Pages /Kids [' + kids + '] /Count ' + pages.length + ' >>',
  );
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (const [index, text] of pages.entries()) {
    const stream = text
      ? 'BT /F1 12 Tf 72 720 Td (' + text.replace(/[\\()]/g, '\\$&') + ') Tj ET'
      : '';
    objects.push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ' +
        (5 + index * 2) +
        ' 0 R >>',
    );
    objects.push(
      '<< /Length ' +
        Buffer.byteLength(stream) +
        ' >>\nstream\n' +
        stream +
        '\nendstream',
    );
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += index + 1 + ' 0 obj\n' + object + '\nendobj\n';
  }
  const start = Buffer.byteLength(pdf);
  pdf += 'xref\n0 ' + offsets.length + '\n0000000000 65535 f \n';
  for (const offset of offsets.slice(1))
    pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
  pdf +=
    'trailer\n<< /Size ' +
    offsets.length +
    ' /Root 1 0 R >>\nstartxref\n' +
    start +
    '\n%%EOF';
  return Buffer.from(pdf);
}
