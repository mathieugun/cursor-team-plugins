"""Tests of live_check.py's archive check (safe_extract). Standard library only: python scripts/live_check_test.py"""

import io
import os
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import live_check  # noqa: E402


def make_archive(path, members):
    """members: (name, type, content or None, linkname) tuples, written in this order."""
    with tarfile.open(path, "w:gz") as tar:
        for name, kind, content, linkname in members:
            info = tarfile.TarInfo(name)
            info.type = kind
            info.mode = 0o755 if kind == tarfile.DIRTYPE else 0o644
            if linkname:
                info.linkname = linkname
            if content is not None:
                data = content.encode()
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
            else:
                tar.addfile(info)


def regular(name, content="x"):
    return (name, tarfile.REGTYPE, content, None)


class SafeExtractTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name).resolve()
        self.dest = self.tmp / "dest"
        self.dest.mkdir()
        self.archive = self.tmp / "remote.tgz"

    def refuses(self, bad):
        # a valid file first: nothing of the archive may be on disk when a later member is refused
        make_archive(self.archive, [regular("first.txt", "first"), bad])
        with self.assertRaises(ValueError):
            live_check.safe_extract(self.archive, self.dest)
        self.assertEqual(list(self.dest.iterdir()), [])

    def test_sibling_folder_with_the_same_prefix(self):
        self.refuses(regular("../dest-other/x"))
        self.assertFalse((self.tmp / "dest-other").exists())

    def test_parent_part_that_comes_back_inside(self):
        # resolves inside dest, but tarfile would create ../new-sibling while making the parent folders
        self.refuses(regular("../new-sibling/../dest/x"))
        self.assertFalse((self.tmp / "new-sibling").exists())

    def test_parent_part_inside_dest(self):
        self.refuses(regular("a/../b"))

    def test_drive_member(self):
        self.refuses(regular("C:x"))

    @unittest.skipUnless(os.name == "nt", "Windows device names")
    def test_windows_device_names(self):
        for name in ("NUL", "a/com1.txt", "Con ", "COM¹", "lpt³.log"):
            with self.subTest(name=name):
                self.refuses(regular(name))

    @unittest.skipUnless(os.name == "nt", "NTFS alternate data streams")
    def test_alternate_data_stream(self):
        self.refuses(regular("logs.txt:review"))

    def test_member_that_overwrites_the_archive(self):
        # fetch_remote writes the archive inside the folder it extracts to
        archive = self.dest / "remote.tgz"
        make_archive(archive, [regular("first.txt", "first"), regular("remote.tgz", "garbage")])
        with self.assertRaises(ValueError):
            live_check.safe_extract(archive, self.dest)
        self.assertEqual([p.name for p in self.dest.iterdir()], ["remote.tgz"])

    def test_absolute_member(self):
        self.refuses(regular(self.tmp.anchor + "x"))

    def test_fifo(self):
        self.refuses(("pipe", tarfile.FIFOTYPE, None, None))

    def test_character_device(self):
        self.refuses(("dev", tarfile.CHRTYPE, None, None))

    def test_symlink(self):
        self.refuses(("link", tarfile.SYMTYPE, None, "x"))

    def test_valid_archive(self):
        make_archive(self.archive, [("a", tarfile.DIRTYPE, None, None), regular("a/b.txt", "hello")])
        live_check.safe_extract(self.archive, self.dest)
        self.assertEqual((self.dest / "a" / "b.txt").read_text(), "hello")


if __name__ == "__main__":
    unittest.main()
