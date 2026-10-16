import { describe, expect, it } from 'vitest';
import { flowProjectProblem } from '../src/core/project-id.js';

describe('a Flow project as its whole address', () => {
  it('takes the address copied from the browser, with its account, and the old bare id', () => {
    expect(flowProjectProblem('https://flow.google.com/u/2/project/dafc82d0-a6e2-4c2d-a6cd-8f495a1343b8')).toBeNull();
    expect(flowProjectProblem('https://labs.google/fx/tools/flow/project/dafc82d0-a6e2-4c2d-a6cd-8f495a1343b8?pli=1')).toBeNull();
    expect(flowProjectProblem('dafc82d0-a6e2-4c2d-a6cd-8f495a1343b8')).toBeNull();
    expect(flowProjectProblem('')).toBeNull();
  });

  it('says how to copy it when it is something else', () => {
    expect(flowProjectProblem('https://flow.google.com/')).toMatch(/whole address of the project/);
    expect(flowProjectProblem('my project')).toMatch(/whole address of the project/);
  });
});
