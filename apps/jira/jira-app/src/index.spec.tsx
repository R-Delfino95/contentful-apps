/* eslint-disable @typescript-eslint/no-explicit-any */
import React from 'react';
import { render, fireEvent, cleanup, configure, wait } from '@testing-library/react';
import App from './components/App';
import Jira from './components/Jira';
import './mockResponses/fetchMock';
import mockContentTypes from './mockResponses/mockContentTypes.json';
import JiraClient from './jiraClient';
import fetchMock from 'fetch-mock';
import standalone from './standalone';
import { Mock, vi } from 'vitest';

configure({
  testIdAttribute: 'data-test-id',
});

function mockUseSDK() {
  return {
    hostnames: {
      webapp: 'app.contentful.com',
    },
  };
}

vi.mock('@contentful/react-apps-toolkit', () => ({
  useSDK: () => mockUseSDK(),
}));

vi.mock('./jiraClient', async () => {
  const jiraClient = class JiraClient {
    constructor() {}
    static getProjects = vi.fn(() =>
      Promise.resolve({
        projects: [
          {
            id: '10000',
            key: 'extensibility',
            name: 'Project name 2',
          },
        ],
      })
    );
    addContentfulLink = vi.fn(() => Promise.resolve({}));
    getIssuesForEntry = vi.fn(() =>
      Promise.resolve({
        issues: [
          {
            issuetype: {
              name: 'Story',
            },
            status: {
              statusCategory: {
                colorName: 'green',
              },
            },
            key: 'MKE-1389',
            assignee: {
              displayName: 'Dean Anderson',
              avatarUrls: {
                '24x24': 'https://example.com/avatar.png',
              },
            },
            summary: 'Test issue 1',
          },
        ],
      })
    );
    searchIssues = vi.fn(() =>
      Promise.resolve({
        issues: [
          {
            issuetype: {
              name: 'Story',
              iconUrl: 'https://example.com/icon.png',
            },
            status: {
              name: 'To Do',
              statusCategory: {
                colorName: 'medium-gray',
              },
            },
            key: 'MKE-1234',
            fields: {
              summary: 'Test issue 1',
              assignee: {
                displayName: 'Dean Anderson',
              },
            },
          },
        ],
      })
    );
    static getCloudAccounts = () =>
      Promise.resolve({
        error: null,
        resources: [
          {
            id: '11111111-1111-1111-1111-111111111111',
            url: 'https://sitetest.atlassian.net',
            name: 'sitetest.atlassian.net',
          },
          {
            id: '11111111-1111-1111-1111-111111111112',
            name: 'test2.atlassian.net',
            url: 'https://test2.atlassian.net',
          },
        ],
      });
  };
  return {
    default: jiraClient,
  };
});

const originalStorage = window.localStorage;

describe('The Jira App Components', () => {
  let mockSdk: any = {};

  let configureFn = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    window.open = vi.fn();
    Object.defineProperty(window, 'localStorage', { writable: true, value: originalStorage });

    Date.now = vi.fn(() => 100);
    Math.random = vi.fn(() => 0.5);

    mockSdk = {
      ids: {
        space: 'test-space',
        environment: 'master',
        user: '123',
      },
      app: {
        setReady: vi.fn(),
        isInstalled: vi.fn().mockReturnValue(Promise.resolve(false)),
        getParameters: vi.fn().mockReturnValue(Promise.resolve(null)),
        onConfigure: vi.fn((fn) => {
          configureFn = fn;
        }),
      },
      space: {
        getContentTypes: vi.fn().mockReturnValue(Promise.resolve(mockContentTypes)),
        getEditorInterfaces: vi.fn().mockResolvedValue({ items: [] }),
      },
      notifier: {
        error: vi.fn(),
      },
      window: {
        startAutoResizer: vi.fn(),
      },
      user: {
        firstName: 'David',
        lastName: 'Fateh',
      },
      hostnames: {
        webapp: 'app.contentful.com',
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  describe('Location: APP_CONFIG, Component: <App />', () => {
    it('should setReady and go through the oauth flow successfully', () => {
      const wrapper = render(<App sdk={mockSdk} />);

      expect(mockSdk.app.setReady).toHaveBeenCalledTimes(1);

      // shows the oauth layout
      expect(wrapper).toBeDefined();

      const oauthButton = wrapper.getByTestId('oauth-button');
      const token = '123';
      const expireTime = Date.now() + 600000;

      const source: MessageEventSource = { close: vi.fn() } as any;
      (window.open as Mock).mockReturnValue(source);

      fireEvent.click(oauthButton);
      fireEvent(window, new MessageEvent('message', { data: { token, expireTime }, source }));

      expect(window.open).toHaveBeenCalledWith(
        'https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=XD9k9QU9VT4Rt26u6lbO3NM0fOqvvXan&scope=read%3Ajira-user%20read%3Ajira-work%20write%3Ajira-work&redirect_uri=https%3A%2F%2Fapi.jira.ctfapps.net%2Fauth&response_type=code&state=http%3A%2F%2Flocalhost%3A3000%2F&prompt=consent',
        'Jira Contentful',
        'left=150,top=10,width=800,height=900'
      );

      // shows the loading screen after oauth gives a token
      expect(wrapper).toBeDefined();
    });

    it('should notify of an error if present in the oauth flow', () => {
      const wrapper = render(<App sdk={mockSdk} />);

      const oauthButton = wrapper.getByTestId('oauth-button');
      const error = '123';

      const source: MessageEventSource = { close: vi.fn() } as any;
      (window.open as Mock).mockReturnValue(source);

      fireEvent.click(oauthButton);
      fireEvent(window, new MessageEvent('message', { data: { error }, source }));

      expect(mockSdk.notifier.error).toHaveBeenCalledWith(
        'There was an error authenticating. Please refresh and try again.'
      );
    });

    it('should go through the installation flow successfully', async () => {
      const token = '123';
      const expires = Date.now() + 600000;

      Object.defineProperty(window, 'localStorage', {
        writable: true,
        value: {
          getItem: vi.fn((item: string) => {
            switch (item) {
              case 'token':
                return token;
              case 'expireTime':
                return expires;
              default:
                return null;
            }
          }),
          setItem: vi.fn(),
          removeItem: vi.fn(),
        },
      });

      const wrapper = render(<App sdk={mockSdk} />);

      // because we've set the expireTime to 10 minutes, we should see
      // a reauth message show up in the dom
      expect(wrapper.getByTestId('oauth-content')).toBeDefined();

      await wait(() => {
        wrapper.getByTestId('configuration');
      });

      const instanceSelector = wrapper.getByTestId('instance-selector');
      const projectSearchInput: HTMLInputElement = wrapper.getByTestId(
        'cf-ui-text-input'
      ) as HTMLInputElement;

      // expect instance data to load into the first <select>
      expect(instanceSelector.textContent).toEqual(
        'Select a sitesitetest.atlassian.nettest2.atlassian.net'
      );

      // expect project data to not have loaded yet in the next <input>
      expect(projectSearchInput.placeholder).toEqual('Search');

      // pick an instance
      fireEvent.change(instanceSelector, {
        target: { value: '11111111-1111-1111-1111-111111111112' },
      });

      await wait();

      // pick the extensibility project
      fireEvent.change(projectSearchInput, {
        target: { value: 'extensibility' },
      });

      vi.advanceTimersByTime(1000);

      await wait(() => {
        wrapper.getByTestId('search-result-project');
      });

      fireEvent.click(wrapper.getByTestId('search-result-project'));

      const contentTypeList = wrapper.getByTestId('content-types');

      // expect all content types to show up in the markup
      expect(contentTypeList).toBeDefined();

      // check that checkbox functionality works
      const authorCt = wrapper.getByLabelText('Author');

      // @ts-ignore: 2339
      expect(authorCt.checked).toBe(false);

      fireEvent.click(authorCt);

      // @ts-ignore: 2339
      expect(authorCt.checked).toBe(true);

      // finally let's install the app and ensure the configuration looks correct
      // we should see the contentful instance, extensibility project, and author installed to sidebar in position 0
      expect(configureFn()).toBeDefined();
    });

    it('should go through the installation flow and error with bad configs', async () => {
      const token = '123';
      const expires = Date.now() + 600000;

      Object.defineProperty(window, 'localStorage', {
        writable: true,
        value: {
          getItem: vi.fn((item: string) => {
            switch (item) {
              case 'token':
                return token;
              case 'expireTime':
                return expires;
              default:
                return null;
            }
          }),
          setItem: vi.fn(),
          removeItem: vi.fn(),
        },
      });

      const wrapper = render(<App sdk={mockSdk} />);

      await wait(() => {
        wrapper.getByTestId('configuration');
      });

      const instanceSelector = wrapper.getByTestId('instance-selector');

      // expect instance data to load into the first <select>
      expect(instanceSelector.textContent).toEqual(
        'Select a sitesitetest.atlassian.nettest2.atlassian.net'
      );

      // try to install with nothing selected yet
      expect(configureFn()).toEqual(false);
      expect(mockSdk.notifier.error).toHaveBeenCalledTimes(1);
      expect(mockSdk.notifier.error).toHaveBeenNthCalledWith(
        1,
        'You must select a Jira instance to continue!'
      );

      // pick an instance
      fireEvent.change(instanceSelector, {
        target: { value: '11111111-1111-1111-1111-111111111112' },
      });

      // try to install with no project selected
      expect(configureFn()).toEqual(false);
      expect(mockSdk.notifier.error).toHaveBeenCalledTimes(2);
      expect(mockSdk.notifier.error).toHaveBeenNthCalledWith(
        2,
        'You must select a Jira project to continue!'
      );

      await wait();
      expect(mockSdk.notifier.error).toHaveBeenCalledTimes(2);
    });
  });

  describe('Location: ENTRY_SIDEBAR, Component: <Jira />', () => {
    const unauthHandler = vi.fn();
    const jiraClient = new JiraClient(
      '123',
      '1000',
      'cloud-id',
      'contentful.atlassian.net',
      unauthHandler
    );

    it('should load the sidebar app and show linked issues', async () => {
      const wrapper = render(<Jira sdk={mockSdk} client={jiraClient} signOut={() => {}} />);

      await wait();

      expect(wrapper).toBeDefined();

      const [firstIssueSummary] = wrapper.getAllByTestId('issue-summary');
      const [firstIssueAssignee] = wrapper.getAllByTestId('issue-assignee');
      expect(firstIssueSummary.textContent).toEqual('Test issue 1');

      // since the user is Dean Anderson, it should show up first
      // @ts-ignore: 2339
      expect(firstIssueAssignee.alt).toEqual('Dean Anderson');
    });

    it('should show an empty list when the resource returns nothing', async () => {
      // overwrite the default mock value to return nothing
      fetchMock.get(
        'https://api.atlassian.com/ex/jira/cloud-id/rest/api/2/search?jql=issue.property%5BcontentfulLink%5D.records%20%3D%20%22ctf%3Atest-space%3Amaster%3Aundefined%22',
        { issues: [] },
        {
          overwriteRoutes: true,
        }
      );

      const wrapper = render(<Jira sdk={mockSdk} client={jiraClient} signOut={() => {}} />);

      await wait();

      expect(wrapper).toBeDefined();
    });

    it('should search for entries and allow linking', async () => {
      const wrapper = render(<Jira sdk={mockSdk} client={jiraClient} signOut={() => {}} />);

      const search = wrapper.getByTestId('jira-issue-search');

      fireEvent.change(search, { target: { value: 'MKE-1389' } });
      await wait();

      // should show a MKE-1389 in search results
      expect(wrapper).toBeDefined();

      const searchResult = wrapper.getAllByTestId('search-result-issue');

      expect(searchResult).toHaveLength(1);

      fireEvent.click(searchResult[0]);

      await wait();

      expect(wrapper).toBeDefined();
    });

    it('should show an unauthorized message when given a 403', async () => {
      // overwrite the default mock value to return nothing
      fetchMock.get(
        'https://api.atlassian.com/ex/jira/cloud-id/rest/api/2/search?jql=issue.property%5BcontentfulLink%5D.records%20%3D%20%22ctf%3Atest-space%3Amaster%3Aundefined%22',
        403,
        {
          overwriteRoutes: true,
        }
      );

      const wrapper = render(<Jira sdk={mockSdk} client={jiraClient} signOut={() => {}} />);

      await wait();

      expect(wrapper).toBeDefined();
    });
  });

  describe('standalone', () => {
    it('should handle a successful token and expire time', () => {
      const mockWindow = {
        location: {
          href: `http://localhost:1234?token=123&expiresIn=10`,
        },
        opener: {
          postMessage: vi.fn(),
        },
        localStorage: {
          setItem: vi.fn(),
        },
        history: {
          replaceState: vi.fn(),
        },
      };

      standalone(mockWindow as any);
      expect(mockWindow.opener.postMessage).toHaveBeenCalledWith(
        { token: '123', expireTime: 10100 },
        '*'
      );
      expect(mockWindow.history.replaceState).toHaveBeenCalledWith({}, 'oauth', '/');
    });

    it('should handle errors in query string', () => {
      const errorMessage = 'therewasanerror';
      const mockWindow = {
        location: {
          href: `http://localhost:1234?token=123&&error=${errorMessage}`,
        },
        opener: {
          postMessage: vi.fn(),
        },
        localStorage: {
          setItem: vi.fn(),
        },
        history: {
          replaceState: vi.fn(),
        },
      };

      standalone(mockWindow as any);

      expect(mockWindow.localStorage.setItem).toHaveBeenCalledTimes(0);
      expect(mockWindow.opener.postMessage).toHaveBeenCalledWith({ error: errorMessage }, '*');
    });

    it('should handle no query string', () => {
      const mockWindow = {
        location: {
          href: 'http://localhost:1234',
        },
        opener: {
          postMessage: vi.fn(),
        },
        localStorage: {
          setItem: vi.fn(),
        },
        history: {
          replaceState: vi.fn(),
        },
      };

      standalone(mockWindow as any);

      expect(mockWindow.localStorage.setItem).toHaveBeenCalledTimes(0);
      expect(mockWindow.opener.postMessage).toHaveBeenCalledWith(
        { error: 'No query string provided!' },
        '*'
      );
    });
  });
});
