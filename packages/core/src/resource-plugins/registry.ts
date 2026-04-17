import type { ResourcePlugin } from "./types.js";

/**
 * Registry for ResourcePlugin instances, keyed by CloudFormation resource type string.
 * Plain class — not a singleton; the default instance is exported from `index.ts`.
 *
 * @example
 * const registry = new PluginRegistry()
 * registry.register(s3BucketPlugin)
 * const plugin = registry.get('AWS::S3::Bucket')
 */
export class PluginRegistry {
  private readonly plugins = new Map<string, ResourcePlugin>();

  /**
   * Register a plugin. If a plugin for the same `resourceType` already exists,
   * it is overwritten.
   */
  register(plugin: ResourcePlugin): void {
    this.plugins.set(plugin.resourceType, plugin);
  }

  /**
   * Retrieve a plugin by CloudFormation resource type.
   * Returns `undefined` if no plugin is registered for the given type.
   */
  get(resourceType: string): ResourcePlugin | undefined {
    return this.plugins.get(resourceType);
  }

  /**
   * Check whether a plugin is registered for the given resource type.
   * Useful for the option-elicitor node (Story 7.3) to decide fallback behaviour.
   */
  has(resourceType: string): boolean {
    return this.plugins.has(resourceType);
  }

  /**
   * Remove a plugin from the registry. Returns true if a plugin was
   * registered and has been removed; false otherwise. Used by tests that
   * register fixture plugins in `beforeEach` and need to clean up in
   * `afterEach` to avoid leaking across files (Story 50-4 Wave 5 Pass H).
   */
  unregister(resourceType: string): boolean {
    return this.plugins.delete(resourceType);
  }
}
