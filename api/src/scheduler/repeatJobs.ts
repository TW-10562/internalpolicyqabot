import { addJob } from '../queue/jobQueue';
import { config } from '@/config/index';

export const registerRepeatJobs = async (): Promise<void> => {
  // every 5 seconds say hello
  // await addJob(
  //   'sayHelloJob',
  //   { name: 'Aviary' },
  //   {
  //     repeat: { cron: '*/5 * * * * *' },
  //   },
  // );

  // every day at 0 AM count logins
  // await addJob(
  //   'countLoginJob',
  //   {},
  //   {
  //     repeat: { cron: '0 * * * * *' },
  //   },
  // );

  const enableRecurringFileUpload = String(process.env.ENABLE_RECURRING_FILE_UPLOAD_JOB || '0') === '1';
  if (enableRecurringFileUpload) {
    // fileUpload
    await addJob(
      'fileUploadJob',
      { folderpath: config.RAG.Uploads.uploadDirectory },
      {
        repeat: { cron: '0 0 1 * * *' },
      },
    );
  } else {
    console.log('[Scheduler] Skipping recurring fileUploadJob (ENABLE_RECURRING_FILE_UPLOAD_JOB != 1)');
  }

  console.log('[Scheduler] all repeatable jobs registered');
};
