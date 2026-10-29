/**
 * Pure-JS SHA-1 (RFC 3174), matching the hash Git stores for "blob" objects.
 *
 * Implemented locally instead of `crypto.subtle.digest` so the plugin behaves
 * identically on desktop and mobile. `crypto.subtle` is only available in
 * secure contexts and may be undefined inside Obsidian's mobile webview, which
 * would otherwise break every sync. Files are kept well under the limit where
 * the 32-bit bit-length encoding below is exact (the plugin caps at ~50 MB).
 */
export function sha1(bytes: Uint8Array): string {
	const blockSize = 64;
	const msgLen = bytes.length;
	// Padded length: original + 0x80 delimiter + 8-byte big-endian bit length, rounded up to 64.
	const totalLen = (msgLen + 1 + 8 + blockSize - 1) & ~(blockSize - 1);
	const padded = new Uint8Array(totalLen);
	padded.set(bytes);
	padded[msgLen] = 0x80;
	// 64-bit big-endian bit length (msgLen * 8) into the final 8 bytes.
	const bitLen = msgLen * 8;
	const hi = Math.floor(bitLen / 0x100000000);
	const lo = bitLen >>> 0;
	padded[totalLen - 8] = (hi >>> 24) & 0xff;
	padded[totalLen - 7] = (hi >>> 16) & 0xff;
	padded[totalLen - 6] = (hi >>> 8) & 0xff;
	padded[totalLen - 5] = hi & 0xff;
	padded[totalLen - 4] = (lo >>> 24) & 0xff;
	padded[totalLen - 3] = (lo >>> 16) & 0xff;
	padded[totalLen - 2] = (lo >>> 8) & 0xff;
	padded[totalLen - 1] = lo & 0xff;

	let h0 = 0x67452301;
	let h1 = 0xefcdab89;
	let h2 = 0x98badcfe;
	let h3 = 0x10325476;
	let h4 = 0xc3d2e1f0;

	const w = new Uint32Array(80);
	for (let off = 0; off < totalLen; off += blockSize) {
		for (let i = 0; i < 16; i++) {
			const j = off + i * 4;
			w[i] = ((padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3]) >>> 0;
		}
		for (let i = 16; i < 80; i++) {
			const n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
			w[i] = ((n << 1) | (n >>> 31)) >>> 0;
		}
		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;
		for (let i = 0; i < 80; i++) {
			let f: number;
			let k: number;
			if (i < 20) {
				f = (b & c) | (~b & d);
				k = 0x5a827999;
			} else if (i < 40) {
				f = b ^ c ^ d;
				k = 0x6ed9eba1;
			} else if (i < 60) {
				f = (b & c) | (b & d) | (c & d);
				k = 0x8f1bbcdc;
			} else {
				f = b ^ c ^ d;
				k = 0xca62c1d6;
			}
			const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
			e = d;
			d = c;
			c = ((b << 30) | (b >>> 2)) >>> 0;
			b = a;
			a = temp;
		}
		h0 = (h0 + a) >>> 0;
		h1 = (h1 + b) >>> 0;
		h2 = (h2 + c) >>> 0;
		h3 = (h3 + d) >>> 0;
		h4 = (h4 + e) >>> 0;
	}
	const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
	return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4);
}

/** Git object hash: sha1("blob <size>\0<content>") — matches the shas both hosts report in trees. */
export async function gitBlobSha1(data: ArrayBuffer): Promise<string> {
	const header = new TextEncoder().encode(`blob ${data.byteLength}\0`);
	const buf = new Uint8Array(header.byteLength + data.byteLength);
	buf.set(header, 0);
	buf.set(new Uint8Array(data), header.byteLength);
	return sha1(buf);
}

export function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}
