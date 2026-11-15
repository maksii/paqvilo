/** A literal HTTP transport choice, excluding explicit loopback development targets. No request is made. */
export function unencryptedTarget(value) {
  if (typeof value !== 'string' || !value.toLowerCase().startsWith('http://')) return false;
  try {
    return !['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}
