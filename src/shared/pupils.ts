import { z } from 'zod';

const epoch = z.uuid();
const note = z.string().trim().max(2000);
const date = z.iso.date();
export const profileContent = z
  .object({
    gender: z.enum(['unspecified', 'female', 'male', 'other']).default('unspecified'),
    birthDate: z.union([date, z.literal('')]).default(''),
    guardianName: z.string().trim().max(80).default(''),
    guardianPhone: z.string().trim().max(40).default(''),
    address: z.string().trim().max(300).default(''),
    interests: note.default(''),
    strengths: note.default(''),
    learningNeeds: note.default(''),
    teacherNotes: note.default(''),
  })
  .strict();
export const profileReadInput = z.object({ epoch, studentId: z.uuid() }).strict();
export const profileSaveInput = profileReadInput.extend({
  expectedRevision: z.number().int().nonnegative(),
  expectedStudentRevision: z.number().int().positive(),
  requestId: z.uuid(),
  content: profileContent,
  reason: z.string().trim().min(1).max(300),
});
export const profileRecord = z
  .object({
    id: z.uuid(),
    studentId: z.uuid(),
    revision: z.number().int().nonnegative(),
    content: profileContent,
    updatedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type StudentProfile = z.infer<typeof profileRecord>;
export const attendanceStatus = z.enum(['unmarked', 'present', 'late', 'excused', 'absent']);
export const attendanceMark = z
  .object({
    studentId: z.uuid(),
    status: attendanceStatus,
    note: z.string().trim().max(300).default(''),
  })
  .strict();
export const attendanceClassInput = z.object({ epoch, classId: z.uuid() }).strict();
export const attendanceReadInput = z.object({ epoch, id: z.uuid() }).strict();
export const attendanceSaveInput = attendanceClassInput.extend({
  id: z.uuid().nullable().default(null),
  expectedRevision: z.number().int().nonnegative(),
  expectedRosterHash: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.uuid(),
  date,
  title: z.string().trim().min(1).max(120),
  classroomId: z.uuid().nullable().default(null),
  marks: z.array(attendanceMark).min(1).max(500),
  reason: z.string().trim().min(1).max(300),
});
export const attendanceRecord = z
  .object({
    id: z.uuid(),
    classId: z.uuid(),
    className: z.string().min(1).max(80),
    revision: z.number().int().positive(),
    date,
    title: z.string().min(1).max(120),
    classroomId: z.uuid().nullable(),
    rosterHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    rows: z
      .array(
        attendanceMark.extend({
          studentNumber: z.string(),
          displayName: z.string().min(1).max(60),
        }),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type AttendanceRecord = z.infer<typeof attendanceRecord>;
export type AttendanceRoster = {
  classId: string;
  className: string;
  rosterHash: string;
  students: Array<{ studentId: string; studentNumber: string; displayName: string }>;
};
export type PupilRevision<T> = { record: T; reason: string; requestId: string; createdAt: string };
