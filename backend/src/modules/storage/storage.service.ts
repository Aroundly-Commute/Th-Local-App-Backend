export abstract class StorageService {
  /**
   * Uploads a file and returns its public URL
   */
  abstract uploadFile(file: Express.Multer.File, directory?: string): Promise<string>;

  /**
   * Deletes a file by its public URL
   */
  abstract deleteFile(fileUrl: string): Promise<void>;
}
