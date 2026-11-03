import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FakeWorker, provideFakeWorkers } from '../testing/fake-worker';
import { appConfig } from './app.config';

describe('appConfig', () => {
  it('starts exactly one producer during app initialization', async () => {
    const workers: FakeWorker[] = [];
    TestBed.configureTestingModule({
      providers: [...appConfig.providers, provideFakeWorkers(workers)],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;

    expect(workers).toHaveLength(1);
  });
});
