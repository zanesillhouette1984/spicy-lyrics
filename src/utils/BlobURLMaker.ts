/**
 * blob: URLs for fetched images, least recently used first. Every blob: URL
 * keeps its image in memory until it is revoked, and none ever was, so each
 * cover and artist header shown stayed in memory for the rest of the session.
 *
 * Revoking only stops new loads of a URL; anything already showing the image
 * keeps it. Every place that puts one of these on screen asks for it here
 * first, which refreshes it, so the ones evicted are many tracks old.
 */
const MAX_CACHED_BLOB_URLS = 32;
const BlobURLCache = new Map<string, string>();

export default async function BlobURLMaker(url: string): Promise<string | null> {
  if (!url) throw new Error("SpicyLyrics: BlobURLMaker: url Missing");
  const existingBlobURL = BlobURLCache.get(url);
  if (existingBlobURL) {
    // Re-insert to mark it as the most recently used.
    BlobURLCache.delete(url);
    BlobURLCache.set(url, existingBlobURL);
    return existingBlobURL;
  }
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }

    const blob = await response.blob();

    // Another call for the same image may have finished while this one fetched.
    const raced = BlobURLCache.get(url);
    if (raced) return raced;

    const blobUrl = URL.createObjectURL(blob);
    BlobURLCache.set(url, blobUrl);

    if (BlobURLCache.size > MAX_CACHED_BLOB_URLS) {
      const [oldestUrl, oldestBlobUrl] = BlobURLCache.entries().next().value!;
      BlobURLCache.delete(oldestUrl);
      URL.revokeObjectURL(oldestBlobUrl);
    }

    return blobUrl;
  } catch (error) {
    console.error("Error fetching and converting to blob URL:", error);
    throw error;
  }
}
