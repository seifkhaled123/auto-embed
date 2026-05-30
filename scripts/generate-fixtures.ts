/**
 * One-off generator for binary parser test fixtures. Run with:
 *
 *   bun run scripts/generate-fixtures.ts
 *
 * Outputs are committed to the repo; this script exists for reproducibility.
 * `pdf-lib` and `docx` are devDependencies — they do NOT ship to users.
 */
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const outDir = path.join(here, "..", "test", "fixtures", "parsers");

async function buildPdf(): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const pages = [
    {
      heading: "Quarterly Field Report — Page 1",
      body: [
        "This is the first page of the sample PDF used by the auto-embed parser tests.",
        "It contains pure ASCII text only, no images or forms, so unpdf should extract",
        "the text cleanly across every Node version we support.",
      ],
    },
    {
      heading: "Quarterly Field Report — Page 2",
      body: [
        "The second page exercises page-number metadata: the parser must emit pageNumber",
        "and pageCount fields so that the chunker can stamp them onto downstream chunks.",
        "Tests assert that page 2 maps to pageNumber 2 with pageCount 3.",
      ],
    },
    {
      heading: "Quarterly Field Report — Page 3",
      body: [
        "The third and final page closes the report. It should be parsed as its own",
        "section, distinct from pages 1 and 2, with metadata indicating that pageCount",
        "equals 3 and that this section sits at the end of the document.",
      ],
    },
  ];

  for (const page of pages) {
    const p = doc.addPage([612, 792]);
    p.drawText(page.heading, { x: 64, y: 720, size: 18, font, color: rgb(0, 0, 0) });
    let y = 680;
    for (const line of page.body) {
      p.drawText(line, { x: 64, y, size: 12, font, color: rgb(0, 0, 0) });
      y -= 18;
    }
  }
  return await doc.save({ updateFieldAppearances: false });
}

async function buildDocx(): Promise<Buffer> {
  const { Document, HeadingLevel, Packer, Paragraph, TextRun } = await import("docx");
  const doc = new Document({
    creator: "auto-embed-test-fixture",
    title: "Sample DOCX",
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun("Release Checklist")],
          }),
          new Paragraph({
            children: [
              new TextRun(
                "This DOCX fixture exercises the mammoth → markdown → markdown-parser path.",
              ),
            ],
          }),
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun("Pre-flight")],
          }),
          new Paragraph({
            children: [
              new TextRun(
                "Run the typecheck, the test suite, and the build before tagging a release.",
              ),
            ],
          }),
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun("Smoke test")],
          }),
          new Paragraph({
            children: [
              new TextRun(
                "Install the produced tarball into a fresh tempdir and run the local embed flow against the README.",
              ),
            ],
          }),
        ],
      },
    ],
  });
  return await Packer.toBuffer(doc);
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const pdfBytes = await buildPdf();
  await fs.writeFile(path.join(outDir, "sample.pdf"), pdfBytes);
  console.log(`wrote ${path.join(outDir, "sample.pdf")} (${pdfBytes.byteLength} bytes)`);

  const docxBytes = await buildDocx();
  await fs.writeFile(path.join(outDir, "sample.docx"), docxBytes);
  console.log(`wrote ${path.join(outDir, "sample.docx")} (${docxBytes.byteLength} bytes)`);
}

await main();
