/**
 * Convert a color temperature expressed in percent to mireds
 * 1 = 2700K = ~370 mireds
 * 100 = 5000K = 200 mireds
 *
 * @param {number} temperaturePercent Color temperature expressed as a percent
 * @returns {number} Color temperature expressed in mireds
 * @private
 */
function tempPercentToMireds(temperaturePercent) {
  const kelvins = 2700 + Math.floor(2300 * (temperaturePercent / 100));
  return Math.round(1e6 / kelvins);
}

/**
 * Convert a color temperature expressed in mireds to percent
 * 1 = 2700K = ~370 mireds
 * 100 = 5000K = 200 mireds
 *
 * @param {number} mireds Color temperature expressed in mireds
 * @returns {number} Color temperature expressed as a percent
 * @private
 */
function miredsToTempPercent(mireds) {
  const kelvins = 1e6 / mireds;
  return Math.ceil(((kelvins - 2700) / 2300) * 100);
}

module.exports = {
  tempPercentToMireds,
  miredsToTempPercent,
  MIN_MIREDS: 200,
  MAX_MIREDS: 370
};
