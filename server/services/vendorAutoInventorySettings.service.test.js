const assert = require("node:assert/strict");
const test = require("node:test");

const {
  _test: { updateSkuExceptionGroups, updateSkuExceptions }
} = require("./vendorAutoInventorySettings.service");
const { getSkuMatchKeys } = require("./autoInventorySkuMatcher");

test("updateSkuExceptions adds one canonical exception and preserves unrelated SKUs", () => {
  assert.deepEqual(
    updateSkuExceptions(
      ["OTHER-100", "PPE-110090080"],
      ["PPE-110090080", "110090080"],
      true
    ),
    ["OTHER-100", "PPE-110090080"]
  );
});

test("updateSkuExceptions removes matching product and vendor SKU aliases", () => {
  assert.deepEqual(
    updateSkuExceptions(
      ["OTHER-100", "110090080", "PPE 110090080"],
      ["PPE-110090080", "110090080"],
      false
    ),
    ["OTHER-100"]
  );
});

test("updateSkuExceptionGroups adds one canonical exception for every missing product", () => {
  assert.deepEqual(
    updateSkuExceptionGroups(
      ["OTHER-100"],
      [
        ["ATS-1039093278", "103-909-3278"],
        ["ATS-2029302164", "2029302164"]
      ],
      true
    ),
    ["OTHER-100", "ATS-1039093278", "ATS-2029302164"]
  );
});

test("SKU matching tolerates vendor grouping dashes", () => {
  const compactSkuKeys = getSkuMatchKeys("ATS-1039093278");
  const groupedSkuKeys = getSkuMatchKeys("103-909-3278");

  assert.equal(
    compactSkuKeys.some((key) => groupedSkuKeys.includes(key)),
    true
  );
});

test("SKU matching recognizes ATS application labels before colon-delimited SKUs", () => {
  const productSkuKeys = getSkuMatchKeys("ATS-309-914-8380");
  const sheetSkuKeys = getSkuMatchKeys("306-10 : 309-914-8380");

  assert.equal(
    productSkuKeys.some((key) => sheetSkuKeys.includes(key)),
    true
  );
});

test("SKU matching does not collapse short ambiguous keys", () => {
  assert.equal(getSkuMatchKeys("AB-12").includes("ab12"), false);
});
