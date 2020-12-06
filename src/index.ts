import * as core from '@actions/core';
import YAML from 'yaml';
import {buildActionLogger, buildConsoleLogger, Logger} from './logger';
import kustomize from './kustomize';
import {
  checkSecrets,
  cleanUpYaml,
  customValidation,
  hackyBoolString,
  removeKustomizeValues
} from './cleanYaml';
import validateYaml from './validation';
import {
  getSettings,
  Settings,
  validateEnvironment,
  validateSettings
} from './setup';
import {runActions} from './outputs';
import {getLabel, makeBox} from './utils';
import {Type} from 'yaml/util';
import {resolve} from 'path';

const main = async () => {
  const isAction = !!process.env.GITHUB_EVENT_NAME;
  const logger = isAction ? buildActionLogger() : buildConsoleLogger();
  if (!isAction) {
    logger.warn(
      'Not running as action because GITHUB_WORKFLOW env var is not set'
    );
  }
  try {
    const settings = getSettings(isAction);
    output(logger, settings.verbose, 'Parsing and validating settings');
    if (settings.verbose) {
      console.log(YAML.stringify(settings));
    }
    await validateSettings(settings);
    output(
      logger,
      settings.verbose,
      'Validating environment (binaries, plugin path etc)'
    );
    await validateEnvironment(
      settings.requiredBins,
      settings.verbose ? logger : undefined
    );
    const {yaml, errors} = await getYaml(settings, logger);
    if (settings.outputActions && settings.outputActions.length) {
      output(logger, settings.verbose, 'Running output actions');
      await runActions(yaml, errors, settings, logger);
    }
    if (errors.length) {
      throw new Error('Invalid yaml:\n' + errors.join('\n'));
    }
    logger.log('Finished');
  } catch (error) {
    console.log(error);
    logger.error(error.message);
    if (isAction) {
      core.setFailed(error.message || 'Failed');
    } else {
      process.exit(1);
    }
  }
};

const output = (logger: Logger, verbose: boolean, msg: string) => {
  if (!verbose) {
    logger.log(msg);
    return;
  }
  logger.log('\n\n' + makeBox(msg));
};

const getYaml = async (settings: Settings, logger: Logger) => {
  const section = (name: string, fn: () => Promise<unknown>) => {
    if (!settings.verbose) {
      output(logger, false, name);
      return fn;
    }
    return core.group(name, async () => {
      output(logger, true, name);
      return await fn();
    });
  };

  const resources = ((await section('Running kustomize', async () => {
    return await kustomize(
      settings.kustomizePath,
      settings.extraResources,
      logger,
      settings.kustomizeArgs
    );
  })) as unknown) as YAML.Document[];

  const docs = ((await section(
    'Removing superfluous kustomize resources',
    async () => {
      return removeKustomizeValues(
        resources,
        settings.verbose ? logger : undefined
      );
    }
  )) as unknown) as YAML.Document[];

  const cleanedDocs = ((await section('Cleaning up YAML', async () => {
    const cleaned = docs.reduce(
      (a, d) => {
        const {doc, modified} = cleanUpYaml(
          d,
          settings.verbose ? logger : undefined
        );
        a.cleanedDocs.push(doc);
        a.modified = a.modified || modified;
        return a;
      },
      {cleanedDocs: <YAML.Document[]>[], modified: false}
    );
    if (!cleaned.modified && settings.verbose) {
      logger.log('No changes required');
    }
    return cleaned.cleanedDocs;
  })) as unknown) as YAML.Document[];

  await section('Checking for un-encrypted secrets', async () => {
    checkSecrets(cleanedDocs, settings.allowedSecrets, logger);
  });

  const yaml = cleanedDocs
    .map(d => {
      if (d.errors.length) {
        console.warn(
          `Document ${getLabel(d)} has errors:\n${YAML.stringify(d.errors)}`
        );
        return `# Document ${getLabel(d)} has errors:\n${YAML.stringify(
          d.errors
        )}`;
      }

      const rx = new RegExp(hackyBoolString.replace(/[^0-9a-z]+/g, '.+'), 'g');
      return YAML.stringify(d).replace(rx, '');
    })
    .join('---\n');
  let errors = cleanedDocs
    .filter(d => d.errors.length)
    .reduce((a, d) => {
      const label = getLabel(d);
      d.errors.forEach(e => {
        a.push(`${label} ${e.linePos} ${e.range}: ${e.message}`);
      });
      return a;
    }, [] as (string | undefined)[]);

  if (settings.validateWithKubeVal) {
    await section('Validating YAML', async () => {
      errors.push(...(await validateYaml(yaml, logger)));
    });
  }
  if (settings.customValidation.length) {
    await section('Running customValidation tests', async () => {
      errors.push(
        ...customValidation(
          yaml,
          settings.customValidation,
          settings.verbose ? logger : undefined
        )
      );
    });
  }

  return {yaml, errors: <string[]>errors.filter(e => e !== undefined)};
};

main();
