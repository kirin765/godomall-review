import { runReviewWorker, type PreparedReviewFile } from './reviewWorkerTask';

export async function prepareReviewFile(file: File): Promise<PreparedReviewFile> {
  const buffer = await file.arrayBuffer();
  const worker = new Worker(new URL('./reviewFile.worker.ts', import.meta.url), { type: 'module' });
  return runReviewWorker(worker, buffer);
}
