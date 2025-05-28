// services/repos.ts
import { AxiosTransport } from "../utils/axiosTransport.js";

export interface ReposService {
  upsertVectorCollection(
    collectionName: string,
    directory: string,
    branch: string,
    artifactId: string,
    repoName?: string,
  ): Promise<void>;
  deleteVectorCollection(collectionName: string): Promise<void>;
}

export const createReposService = (
  tx: AxiosTransport,
): ReposService => ({
  async upsertVectorCollection(collectionName, directory, branch, artifactId, repoName) {
    console.error("upsertVectorCollection - ", collectionName, directory, branch, artifactId, repoName);
    try {
      const response = await tx.post("/api/v1/collections/upsert/", {
        collectionName,
        directory,
        branch,
        artifactId,
        repoName,
      });
      console.error("upsertVectorCollection response - ", response);
    } catch (error) {
      console.error("Error upserting vector collection", error);
      throw error;
    }
  },

  async deleteVectorCollection(collectionName) {
    console.error("deleteVectorCollection - ", collectionName);
    await tx.delete(`/api/v1/collections/${collectionName}/`);
  },
});
