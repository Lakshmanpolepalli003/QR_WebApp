'use strict';
/* Tests for the barcode generator validators (bcValidate, gs1CheckDigit,
 * upceToUpcaBody). These run the app's real exported functions in Node —
 * the same code path the browser uses before rendering with JsBarcode. */
const assert = require('assert');
const app = require('../app.js');

const { bcValidate, gs1CheckDigit, upceToUpcaBody, bcFormatLabel, BC_FORMATS } = app;

/* --- gs1CheckDigit (Mod-10, 3/1 weighting, from the right) --------------- */
assert.strictEqual(gs1CheckDigit('400638133393'), '1');   // canonical EAN-13 example
assert.strictEqual(gs1CheckDigit('0123456'), '5');       // GS1 sample → 01234565
assert.strictEqual(gs1CheckDigit('01234500005'), '8');    // UPC-A body → 012345000058

/* --- UPC-E → UPC-A expansion (GS1 table, mirrors ZXing UPCEReader) -------
   All expected values verified against the classic UPC-E examples. -------- */
assert.strictEqual(upceToUpcaBody('0120000'), '01200000000'); // d6=0
assert.strictEqual(upceToUpcaBody('0121000'), '01200000100'); // d6=1
assert.strictEqual(upceToUpcaBody('0122000'), '01200000200'); // d6=2
assert.strictEqual(upceToUpcaBody('0123000'), '01200000300'); // d6=3
assert.strictEqual(upceToUpcaBody('0123400'), '01200000340'); // d6=4
assert.strictEqual(upceToUpcaBody('0123456'), '01234500006'); // d6=6 (classic example)
assert.strictEqual(upceToUpcaBody('0987654'), '09876000005'); // d6=5

/* --- CODE128 ------------------------------------------------------------- */
assert.strictEqual(bcValidate('CODE128', 'Hello-World 123'), null);
assert.strictEqual(bcValidate('CODE128', ''), 'Please enter a barcode value.');
assert.strictEqual(bcValidate('CODE128', 'héllo'), 'CODE128 supports only ASCII characters (no accents or emoji).');
assert.strictEqual(bcValidate('CODE128', '🎉'), 'CODE128 supports only ASCII characters (no accents or emoji).');

/* --- CODE39 -------------------------------------------------------------- */
assert.strictEqual(bcValidate('CODE39', 'ABC-1234'), null);
assert.strictEqual(bcValidate('CODE39', 'A B.$/+%'), null);
assert.strictEqual(bcValidate('CODE39', 'abc'), 'CODE39 supports only A–Z, digits, spaces and - . $ / + %.');
assert.strictEqual(bcValidate('CODE39', 'AB@CD'), 'CODE39 supports only A–Z, digits, spaces and - . $ / + %.');

/* --- EAN-13 -------------------------------------------------------------- */
assert.strictEqual(bcValidate('EAN13', '400638133393'), null);   // 12 digits → auto check
assert.strictEqual(bcValidate('EAN13', '4006381333931'), null);  // 13 digits, valid check
assert.strictEqual(bcValidate('EAN13', '4006381333932'), 'Invalid EAN-13 check digit.');
assert.strictEqual(bcValidate('EAN13', '40063813339'), 'EAN-13 requires a valid 12/13-digit value.');
assert.strictEqual(bcValidate('EAN13', '40063813339312'), 'EAN-13 requires a valid 12/13-digit value.');
assert.strictEqual(bcValidate('EAN13', '40063813339a'), 'EAN-13 requires a valid 12/13-digit value.');

/* --- EAN-8 --------------------------------------------------------------- */
assert.strictEqual(bcValidate('EAN8', '9638507'), null);
assert.strictEqual(bcValidate('EAN8', '96385074'), null);
assert.strictEqual(bcValidate('EAN8', '96385075'), 'Invalid EAN-8 check digit.');
assert.strictEqual(bcValidate('EAN8', '963850'), 'EAN-8 requires a valid 7/8-digit value.');

/* --- UPC-A --------------------------------------------------------------- */
assert.strictEqual(bcValidate('UPC', '01234500005'), null);
assert.strictEqual(bcValidate('UPC', '012345000058'), null);
assert.strictEqual(bcValidate('UPC', '012345000055'), 'Invalid UPC-A check digit.');
assert.strictEqual(bcValidate('UPC', '0123450000'), 'UPC-A requires a valid 11/12-digit value.');

/* --- UPC-E ---------------------------------------------------------------- */
assert.strictEqual(bcValidate('UPCE', '123456'), null);          // 6 digits, ns defaults
assert.strictEqual(bcValidate('UPCE', '01234565'), null);        // 7 digits
// Full 8-digit codes whose check digits are computed via the expansion table
assert.strictEqual(bcValidate('UPCE', '0123456' + gs1CheckDigit(upceToUpcaBody('0123456'))), null);   // 01234565
assert.strictEqual(bcValidate('UPCE', '0987654' + gs1CheckDigit(upceToUpcaBody('0987654'))), null);   // 09876547
assert.strictEqual(bcValidate('UPCE', '0123400' + gs1CheckDigit(upceToUpcaBody('0123400'))), null);   // 01234000
assert.strictEqual(bcValidate('UPCE', '0123456000'), 'UPC-E requires a valid 6–8-digit value.');
assert.strictEqual(bcValidate('UPCE', '91234565'), 'UPC-E number system must be 0 or 1.');
// Wrong check digit: flip the correct one
const correctCd = gs1CheckDigit(upceToUpcaBody('0123456'));
const wrongCd = correctCd === '0' ? '1' : '0';
assert.strictEqual(bcValidate('UPCE', '0123456' + wrongCd), 'Invalid UPC-E check digit.');

/* --- ITF-14 --------------------------------------------------------------- */
const itf14Body = '1234567890123';
assert.strictEqual(bcValidate('ITF14', itf14Body), null);
assert.strictEqual(bcValidate('ITF14', itf14Body + gs1CheckDigit(itf14Body)), null);
assert.strictEqual(bcValidate('ITF14', itf14Body + (gs1CheckDigit(itf14Body) === '0' ? '1' : '0')), 'Invalid ITF-14 check digit.');
assert.strictEqual(bcValidate('ITF14', '123456789012'), 'ITF-14 requires a valid 13/14-digit value.');

/* --- ITF ------------------------------------------------------------------- */
assert.strictEqual(bcValidate('ITF', '1234'), null);
assert.strictEqual(bcValidate('ITF', '123'), 'ITF requires an even number of digits.');
assert.strictEqual(bcValidate('ITF', '12a4'), 'ITF supports digits only.');
assert.strictEqual(bcValidate('ITF', '1234567890123456789012345678901234'), 'ITF requires 2–32 digits (even length).');

/* --- Codabar ---------------------------------------------------------------- */
assert.strictEqual(bcValidate('codabar', 'A123456B'), null);
assert.strictEqual(bcValidate('codabar', 'C12-$:/.+C'), null);
assert.strictEqual(bcValidate('codabar', '123456'), 'Codabar needs digits and - $ : / . + between start/stop letters A–D (e.g. A123456B).');
assert.strictEqual(bcValidate('codabar', 'E123456F'), 'Codabar needs digits and - $ : / . + between start/stop letters A–D (e.g. A123456B).');

/* --- format list + label sanity ---------------------------------------------- */
assert.deepStrictEqual([...BC_FORMATS].sort(), ['CODE128', 'CODE39', 'EAN13', 'EAN8', 'ITF', 'ITF14', 'UPC', 'UPCE', 'codabar'].sort());
assert.strictEqual(bcFormatLabel('EAN13'), 'EAN-13');
assert.strictEqual(bcFormatLabel('UPC'), 'UPC-A');
assert.strictEqual(bcFormatLabel('UPCE'), 'UPC-E');
assert.strictEqual(bcFormatLabel('ITF14'), 'ITF-14');
assert.strictEqual(bcFormatLabel('codabar'), 'Codabar');
assert.strictEqual(bcFormatLabel('CODE128'), 'CODE128');

/* --- whitespace tolerance ------------------------------------------------------ */
assert.strictEqual(bcValidate('EAN13', '  400638133393  '), null);
assert.strictEqual(bcValidate('CODE128', '  ok  '), null);

console.log('barcode-gen.test.js: all assertions passed');
