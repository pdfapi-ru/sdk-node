/**
 * docx, xlsx или pptx в PDF (тариф premium и выше).
 *
 *   PDFAPI_KEY=pdf_live_... node examples/office.ts report.docx
 */
import { PdfApi } from 'pdfapi';

const source = process.argv[2] ?? 'report.docx';

const pdf = await new PdfApi().office(source); // путь, Uint8Array/Buffer (с filename) или Blob/File
const target = await pdf.save(source.replace(/\.(docx|xlsx|pptx)$/i, '') + '.pdf');
console.log(`${target}: ${pdf.pages} стр.`);
