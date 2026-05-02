import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockApproveCandidate = mock();
const mockGetCandidateById = mock();
const mockMarkCandidateRecorded = mock();
const mockRejectCandidate = mock();
const mockRecordTaskNote = mock();

mock.module('../src/services/sessionSummary/repository.js', () => ({
  approveCandidate: mockApproveCandidate,
  getCandidateById: mockGetCandidateById,
  markCandidateRecorded: mockMarkCandidateRecorded,
  rejectCandidate: mockRejectCandidate,
}));

mock.module('../src/services/agentFirst.js', () => ({
  recordTaskNote: mockRecordTaskNote,
}));

import {
  approveSessionKnowledgeCandidate,
  recordSessionKnowledgeCandidate,
  rejectSessionKnowledgeCandidate,
} from '../src/services/sessionKnowledge/approval.js';

describe('sessionKnowledge approval service', () => {
  beforeEach(() => {
    mockApproveCandidate.mockReset();
    mockGetCandidateById.mockReset();
    mockMarkCandidateRecorded.mockReset();
    mockRejectCandidate.mockReset();
    mockRecordTaskNote.mockReset();
  });

  it('rejects record when candidate is not approved', async () => {
    mockGetCandidateById.mockResolvedValue({
      id: 'c1',
      approvalStatus: 'pending',
    });

    await expect(recordSessionKnowledgeCandidate('c1')).rejects.toThrow(
      'candidate must be approved before record',
    );
    expect(mockRecordTaskNote).not.toHaveBeenCalled();
  });

  it('maps non-standard kind to observation and stores promoted note id', async () => {
    mockGetCandidateById.mockResolvedValue({
      id: 'c2',
      distillationId: 'd1',
      turnIndex: 2,
      title: 'temp',
      statement: 'do x',
      kind: 'candidate',
      confidence: 0.7,
      approvalStatus: 'approved',
      evidence: [{ kind: 'result', text: 'ok' }],
    });
    mockRecordTaskNote.mockResolvedValue({ saved: true, entityId: 'note-1' });
    mockMarkCandidateRecorded.mockResolvedValue({});

    const result = await recordSessionKnowledgeCandidate('c2');
    expect(result.promotedNoteId).toBe('note-1');
    expect(mockRecordTaskNote).toHaveBeenCalledTimes(1);
    expect(mockRecordTaskNote.mock.calls[0]?.[0]?.kind).toBe('observation');
    expect(mockMarkCandidateRecorded).toHaveBeenCalledWith('c2', {
      promotedNoteId: 'note-1',
      recordError: null,
    });
  });

  it('stores recordError when record_task_note returns saved=false', async () => {
    mockGetCandidateById.mockResolvedValue({
      id: 'c3',
      distillationId: 'd1',
      turnIndex: 0,
      title: 'rule',
      statement: 'always verify',
      kind: 'rule',
      confidence: 0.9,
      approvalStatus: 'approved',
      evidence: [],
    });
    mockRecordTaskNote.mockResolvedValue({ saved: false, entityId: null });
    mockMarkCandidateRecorded.mockResolvedValue({});

    await expect(recordSessionKnowledgeCandidate('c3')).rejects.toThrow(
      'record_task_note returned saved=false',
    );
    expect(mockMarkCandidateRecorded).toHaveBeenCalledWith('c3', {
      promotedNoteId: null,
      recordError: 'record_task_note returned saved=false',
    });
  });

  it('approve/reject throw when candidate is missing', async () => {
    mockApproveCandidate.mockResolvedValue(null);
    await expect(approveSessionKnowledgeCandidate('missing')).rejects.toThrow(
      'candidate not found: missing',
    );

    mockRejectCandidate.mockResolvedValue(null);
    await expect(rejectSessionKnowledgeCandidate('missing', 'nope')).rejects.toThrow(
      'candidate not found: missing',
    );
  });
});
