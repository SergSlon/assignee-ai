/**
 * EFS FileSystem destroy strategy — preDestroy deletes every mount
 * target and polls until none remain (max 60 s).
 *
 * Mount targets are in NO_TAG_TYPES (no managed-by tag) so they're
 * invisible to the tag-based bulk-destroy discovery. Without this
 * pre-delete hook, DeleteFileSystem fails with "has mount targets"
 * (409 FileSystemInUse).
 *
 * @see Wave-6 F1b
 */

import { RESOURCE_TYPES } from "@assignee/core";
import type { DestroyStrategy } from "./types.js";
import { requireAssigneeCredentials } from "../../config/aws-credentials.js";
import { AWS_REGION } from "../../config/constants.js";
import { warnDestroy } from "./helpers.js";

/** Poll cap for mount-target deletion propagation: 30 × 2s = 60s. */
const EFS_MT_POLL_MAX_ATTEMPTS = 30;
const EFS_MT_POLL_INTERVAL_MS = 2000;

export const efsFileSystemStrategy: DestroyStrategy = {
  resourceType: RESOURCE_TYPES.EFS_FILE_SYSTEM,
  async preDestroy(ctx) {
    const { resource, awsConfig } = ctx;
    try {
      const {
        EFSClient,
        DescribeMountTargetsCommand,
        DeleteMountTargetCommand,
      } = await import("@aws-sdk/client-efs");
      const efs = new EFSClient({
        region: awsConfig.region ?? AWS_REGION,
        credentials: requireAssigneeCredentials("operator"),
      });
      const desc = await efs.send(
        new DescribeMountTargetsCommand({
          FileSystemId: resource.identifier,
        }),
      );
      const mountTargets = desc.MountTargets ?? [];
      for (const mt of mountTargets) {
        if (mt.MountTargetId) {
          try {
            await efs.send(
              new DeleteMountTargetCommand({
                MountTargetId: mt.MountTargetId,
              }),
            );
          } catch (mtErr) {
            warnDestroy("efs_mount_target_delete_failed", {
              fileSystemId: resource.identifier,
              mountTargetId: mt.MountTargetId,
              error: mtErr instanceof Error ? mtErr.message : String(mtErr),
            });
          }
        }
      }
      // Mount target deletion is async — poll until all are gone (max 60s)
      if (mountTargets.length > 0) {
        for (let attempt = 0; attempt < EFS_MT_POLL_MAX_ATTEMPTS; attempt++) {
          const check = await efs.send(
            new DescribeMountTargetsCommand({
              FileSystemId: resource.identifier,
            }),
          );
          if (!check.MountTargets || check.MountTargets.length === 0) break;
          await new Promise((r) => setTimeout(r, EFS_MT_POLL_INTERVAL_MS));
        }
      }
    } catch (err) {
      warnDestroy("efs_mount_target_cleanup_failed", {
        identifier: resource.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
