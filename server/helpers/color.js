/**
 * Convert a string to a consistent HSL color using hash algorithm
 * @param {string} str - The string to convert to a color
 * @returns {string} HSL color string
 */
export function stringToColor(str) {
    // DJB2 hash algorithm for good distribution
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 33) ^ str.charCodeAt(i);
    }

    // Map hash to hue (0-360 degrees)
    const hue = Math.abs(hash) % 360;

    // Use fixed saturation and lightness for vibrant, consistent colors
    return `hsl(${hue}, 65%, 55%)`;
}
