import { exec } from 'child_process';
import gulp from 'gulp';
import shell from 'gulp-shell';
import nodemon from 'gulp-nodemon';
import download from 'gulp-download-stream';
import transform from 'gulp-transform';
import rename from 'gulp-rename';
import wait from 'gulp-wait';
import dotenv from 'dotenv';
import yaml from 'js-yaml';
import fs from 'fs/promises';

const { task, series, parallel } = gulp;
dotenv.config({path: './.env'});

task('vite-watch', shell.task(['vite build --watch']));

task('vite-build', (cb) => {
  exec('vite build', (err, stdout, stderr) => {
    console.log(stdout);
    console.error(stderr);
    cb(err);
  });
});

task('nodemon', (cb) => {
  let started = false;
  return nodemon({
    script: 'app.js',
    ext: '*',
    ignore: ['node_modules/', 'abi/', 'public/'],
  }).on('start', () => {
    if (!started) {
      cb();
      started = true;
    }
  });
});

task('download-abi', async (cb) => {
  const contracts = yaml.load(await fs.readFile('./../../contracts.yml', 'utf8'));

  for (const contract of contracts) {
    const abiUrl = `https://api-sepolia.arbiscan.io/api?module=contract&action=getabi&address=${contract.address}`;

    try {
      await new Promise((resolve) => {
        download(abiUrl)
          .pipe(wait(300))
          .pipe(rename(`${contract.address}.json`))
          .pipe(transform('utf8', (content) => JSON.parse(content).result))
          .pipe(gulp.dest('./abi/'))
          .on('end', () => {
            resolve();
          })
          .on('error', (err) => {
            console.error(`Error downloading ABI for ${contract.address}: ${err.message}`);
            resolve();
          });
      });
    } catch(err) {
      console.log(err);
    }
  }

  cb()
});

task('default', series('download-abi', 'vite-build', 'nodemon'));
task('dev', parallel('nodemon', 'download-abi', 'vite-watch'));
